package com.coworkos.companion

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.os.Build
import androidx.core.content.ContextCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.*
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.math.pow

/**
 * Connection states for the Control Plane WebSocket
 */
enum class ConnectionState {
    DISCONNECTED, CONNECTING, AUTHENTICATING, CONNECTED, RECONNECTING
}

/**
 * Manages the WebSocket connection to the CoWork Control Plane.
 * Handles authentication, command dispatch, and auto-reconnection.
 */
class CoWorkConnection(private val context: Context) {

    // Observable state
    private val _state = MutableStateFlow(ConnectionState.DISCONNECTED)
    val state = _state.asStateFlow()

    private val _lastCommand = MutableStateFlow("")
    val lastCommand = _lastCommand.asStateFlow()

    private val _commandCount = MutableStateFlow(0)
    val commandCount = _commandCount.asStateFlow()

    private val _errorMessage = MutableStateFlow<String?>(null)
    val errorMessage = _errorMessage.asStateFlow()

    // Settings
    private val prefs = context.getSharedPreferences("cowork", Context.MODE_PRIVATE)
    var serverHost: String
        get() = prefs.getString("host", "") ?: ""
        set(value) = prefs.edit().putString("host", value).apply()
    var serverPort: Int
        get() = prefs.getInt("port", 18789)
        set(value) = prefs.edit().putInt("port", value).apply()
    var token: String
        get() = prefs.getString("token", "") ?: ""
        set(value) = prefs.edit().putString("token", value).apply()
    var autoReconnect: Boolean
        get() = prefs.getBoolean("auto_reconnect", true)
        set(value) = prefs.edit().putBoolean("auto_reconnect", value).apply()

    // Private
    private var webSocket: WebSocket? = null
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MINUTES) // No read timeout for WebSocket
        .build()
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var reconnectAttempt = 0
    private val maxReconnectAttempts = 10
    private var reconnectJob: Job? = null
    private var isForeground = true

    private val locationClient: FusedLocationProviderClient by lazy {
        LocationServices.getFusedLocationProviderClient(context)
    }

    // MARK: - Connection Lifecycle

    fun connect() {
        if (serverHost.isBlank() || token.isBlank()) {
            _errorMessage.value = "Server host and token are required"
            return
        }

        disconnect(cleanly = false)
        _state.value = ConnectionState.CONNECTING
        _errorMessage.value = null

        val url = "ws://$serverHost:$serverPort"
        val request = Request.Builder().url(url).build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                scope.launch { authenticate() }
            }

            override fun onMessage(ws: WebSocket, text: String) {
                scope.launch { handleMessage(text) }
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                ws.close(1000, null)
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                scope.launch {
                    if (_state.value != ConnectionState.DISCONNECTED) {
                        scheduleReconnect()
                    }
                }
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                scope.launch {
                    _errorMessage.value = t.message
                    if (_state.value != ConnectionState.DISCONNECTED) {
                        scheduleReconnect()
                    }
                }
            }
        })
    }

    fun disconnect(cleanly: Boolean = true) {
        reconnectJob?.cancel()
        reconnectJob = null
        reconnectAttempt = 0
        webSocket?.close(1000, "Client disconnect")
        webSocket = null
        if (cleanly) {
            _state.value = ConnectionState.DISCONNECTED
        }
    }

    fun setForeground(foreground: Boolean) {
        isForeground = foreground
        if (_state.value == ConnectionState.CONNECTED) {
            sendJSON(JSONObject().apply {
                put("type", "req")
                put("id", UUID.randomUUID().toString())
                put("method", "node.event")
                put("params", JSONObject().apply {
                    put("event", "foreground_changed")
                    put("payload", JSONObject().put("isForeground", foreground))
                })
            })
        }
    }

    fun destroy() {
        disconnect()
        scope.cancel()
    }

    // MARK: - Auto-Reconnect

    private fun scheduleReconnect() {
        if (!autoReconnect || reconnectAttempt >= maxReconnectAttempts) {
            _state.value = ConnectionState.DISCONNECTED
            return
        }

        _state.value = ConnectionState.RECONNECTING
        reconnectAttempt++
        val delay = min(2.0.pow(reconnectAttempt.toDouble()), 60.0).toLong() * 1000

        reconnectJob = scope.launch {
            delay(delay)
            connect()
        }
    }

    // MARK: - Authentication

    private fun authenticate() {
        _state.value = ConnectionState.AUTHENTICATING

        val deviceId = android.provider.Settings.Secure.getString(
            context.contentResolver, android.provider.Settings.Secure.ANDROID_ID
        )
        val cameraPermission = ContextCompat.checkSelfPermission(
            context, Manifest.permission.CAMERA
        ) == PackageManager.PERMISSION_GRANTED
        val locationPermission = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

        val frame = JSONObject().apply {
            put("type", "req")
            put("id", UUID.randomUUID().toString())
            put("method", "connect")
            put("params", JSONObject().apply {
                put("token", token)
                put("role", "node")
                put("client", JSONObject().apply {
                    put("id", deviceId)
                    put("displayName", Build.MODEL)
                    put("version", "1.0.0")
                    put("platform", "android")
                    put("modelIdentifier", "${Build.MANUFACTURER}/${Build.MODEL}")
                })
                put("capabilities", org.json.JSONArray(listOf("camera", "location", "system")))
                put("commands", org.json.JSONArray(listOf("camera.snap", "location.get", "system.notify")))
                put("permissions", JSONObject().apply {
                    put("camera", cameraPermission)
                    put("location", locationPermission)
                })
            })
        }

        sendJSON(frame)
    }

    // MARK: - Message Handling

    private fun handleMessage(text: String) {
        val json = try { JSONObject(text) } catch (e: Exception) { return }
        when (json.optString("type")) {
            "res" -> handleResponse(json)
            "req" -> handleRequest(json)
            "event" -> { /* heartbeat, etc. */ }
        }
    }

    private fun handleResponse(json: JSONObject) {
        val ok = json.optBoolean("ok", false)
        if (ok) {
            if (_state.value == ConnectionState.AUTHENTICATING) {
                _state.value = ConnectionState.CONNECTED
                reconnectAttempt = 0
                _errorMessage.value = null
            }
        } else {
            val msg = json.optJSONObject("error")?.optString("message") ?: "Unknown error"
            _errorMessage.value = msg
            if (_state.value == ConnectionState.AUTHENTICATING) {
                _state.value = ConnectionState.DISCONNECTED
            }
        }
    }

    // MARK: - Command Dispatch

    private fun handleRequest(json: JSONObject) {
        val method = json.optString("method")
        val requestId = json.optString("id")
        if (method.isBlank() || requestId.isBlank()) return

        if (method != "node.invoke") {
            sendError(requestId, "UNKNOWN_METHOD", "Unknown method: $method")
            return
        }

        val params = json.optJSONObject("params") ?: return
        val command = params.optString("command")
        if (command.isBlank()) return

        _lastCommand.value = command
        _commandCount.value++

        val cmdParams = params.optJSONObject("params")

        when (command) {
            "camera.snap" -> handleCameraSnap(requestId, cmdParams)
            "location.get" -> handleLocationGet(requestId, cmdParams)
            "system.notify" -> handleSystemNotify(requestId, cmdParams)
            else -> sendError(requestId, "COMMAND_NOT_SUPPORTED", "Unsupported: $command")
        }
    }

    // MARK: - Camera

    private fun handleCameraSnap(requestId: String, params: JSONObject?) {
        if (!isForeground) {
            sendError(requestId, "NODE_BACKGROUND_UNAVAILABLE", "App must be in foreground")
            return
        }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED
        ) {
            sendError(requestId, "PERMISSION_DENIED", "Camera permission not granted")
            return
        }

        // Camera capture requires CameraX or Camera2 API with preview surface
        // This sends a placeholder; real implementation should use CameraX ImageCapture
        sendError(requestId, "NOT_IMPLEMENTED", "Camera capture requires active Activity context")
    }

    // MARK: - Location

    @Suppress("MissingPermission")
    private fun handleLocationGet(requestId: String, params: JSONObject?) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) {
            sendError(requestId, "PERMISSION_DENIED", "Location permission not granted")
            return
        }

        val accuracy = params?.optString("accuracy") ?: "precise"
        val priority = if (accuracy == "coarse")
            Priority.PRIORITY_BALANCED_POWER_ACCURACY
        else
            Priority.PRIORITY_HIGH_ACCURACY

        locationClient.getCurrentLocation(priority, null)
            .addOnSuccessListener { location: Location? ->
                if (location != null) {
                    sendJSON(JSONObject().apply {
                        put("type", "res")
                        put("id", requestId)
                        put("ok", true)
                        put("payload", JSONObject().apply {
                            put("latitude", location.latitude)
                            put("longitude", location.longitude)
                            put("accuracy", location.accuracy.toDouble())
                            put("altitude", location.altitude)
                            put("timestamp", location.time)
                        })
                    })
                } else {
                    sendError(requestId, "LOCATION_ERROR", "Location unavailable")
                }
            }
            .addOnFailureListener { e ->
                sendError(requestId, "LOCATION_ERROR", e.message ?: "Location failed")
            }
    }

    // MARK: - System Notify

    private fun handleSystemNotify(requestId: String, params: JSONObject?) {
        val title = params?.optString("title") ?: "CoWork"
        val message = params?.optString("message") ?: ""

        // Send notification using Android NotificationManager
        val notifManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = android.app.NotificationChannel(
                "cowork_commands",
                "CoWork Commands",
                android.app.NotificationManager.IMPORTANCE_DEFAULT
            )
            notifManager.createNotificationChannel(channel)
        }

        val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            android.app.Notification.Builder(context, "cowork_commands")
        } else {
            @Suppress("DEPRECATION")
            android.app.Notification.Builder(context)
        }
            .setContentTitle(title)
            .setContentText(message)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setAutoCancel(true)
            .build()

        notifManager.notify(System.currentTimeMillis().toInt(), notification)

        sendJSON(JSONObject().apply {
            put("type", "res")
            put("id", requestId)
            put("ok", true)
            put("payload", JSONObject().put("delivered", true))
        })
    }

    // MARK: - Helpers

    private fun sendJSON(json: JSONObject) {
        webSocket?.send(json.toString())
    }

    private fun sendError(requestId: String, code: String, message: String) {
        sendJSON(JSONObject().apply {
            put("type", "res")
            put("id", requestId)
            put("ok", false)
            put("error", JSONObject().apply {
                put("code", code)
                put("message", message)
            })
        })
    }
}
