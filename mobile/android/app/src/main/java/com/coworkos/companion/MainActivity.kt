package com.coworkos.companion

import android.Manifest
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver

class MainActivity : ComponentActivity() {

    private lateinit var connection: CoWorkConnection

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { /* Permissions result handled by connection on next auth */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        connection = CoWorkConnection(applicationContext)

        // Request necessary permissions
        permissionLauncher.launch(arrayOf(
            Manifest.permission.CAMERA,
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.POST_NOTIFICATIONS
        ))

        // Track foreground/background
        lifecycle.addObserver(LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> connection.setForeground(true)
                Lifecycle.Event.ON_STOP -> connection.setForeground(false)
                else -> {}
            }
        })

        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    CompanionApp(connection)
                }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        connection.destroy()
    }
}

@Composable
fun CompanionApp(connection: CoWorkConnection) {
    var showSettings by remember { mutableStateOf(false) }

    val state by connection.state.collectAsState()
    val lastCommand by connection.lastCommand.collectAsState()
    val commandCount by connection.commandCount.collectAsState()
    val errorMessage by connection.errorMessage.collectAsState()

    if (showSettings) {
        SettingsScreen(connection) { showSettings = false }
    } else {
        MainScreen(
            state = state,
            lastCommand = lastCommand,
            commandCount = commandCount,
            errorMessage = errorMessage,
            onConnect = { connection.connect() },
            onDisconnect = { connection.disconnect() },
            onSettings = { showSettings = true },
            isConfigured = connection.serverHost.isNotBlank() && connection.token.isNotBlank()
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(
    state: ConnectionState,
    lastCommand: String,
    commandCount: Int,
    errorMessage: String?,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
    onSettings: () -> Unit,
    isConfigured: Boolean
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("CoWork Companion") },
                actions = {
                    IconButton(onClick = onSettings) {
                        Text("Settings") // Replace with Icon in production
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Status card
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            modifier = Modifier
                                .size(12.dp)
                                .clip(CircleShape)
                                .background(
                                    when (state) {
                                        ConnectionState.CONNECTED -> Color.Green
                                        ConnectionState.CONNECTING,
                                        ConnectionState.AUTHENTICATING,
                                        ConnectionState.RECONNECTING -> Color(0xFFFFA500)
                                        ConnectionState.DISCONNECTED -> Color.Red
                                    }
                                )
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = when (state) {
                                ConnectionState.DISCONNECTED -> "Disconnected"
                                ConnectionState.CONNECTING -> "Connecting..."
                                ConnectionState.AUTHENTICATING -> "Authenticating..."
                                ConnectionState.CONNECTED -> "Connected to CoWork"
                                ConnectionState.RECONNECTING -> "Reconnecting..."
                            },
                            style = MaterialTheme.typography.titleMedium
                        )
                    }

                    errorMessage?.let {
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }

            // Connect/disconnect button
            Button(
                onClick = {
                    if (state == ConnectionState.CONNECTED || state == ConnectionState.RECONNECTING) {
                        onDisconnect()
                    } else {
                        onConnect()
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = isConfigured,
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (state == ConnectionState.CONNECTED || state == ConnectionState.RECONNECTING)
                        MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.primary
                )
            ) {
                Text(
                    if (state == ConnectionState.CONNECTED || state == ConnectionState.RECONNECTING)
                        "Disconnect"
                    else "Connect",
                    modifier = Modifier.padding(8.dp)
                )
            }

            // Stats card (when connected)
            if (state == ConnectionState.CONNECTED) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Text("Activity", style = MaterialTheme.typography.titleMedium)
                        Spacer(modifier = Modifier.height(12.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceEvenly
                        ) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Text("$commandCount", style = MaterialTheme.typography.headlineSmall)
                                Text("Commands", style = MaterialTheme.typography.labelSmall)
                            }
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Text(
                                    lastCommand.ifBlank { "-" },
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontFamily = FontFamily.Monospace
                                )
                                Text("Last Command", style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                }
            }

            // Setup instructions (when disconnected)
            if (state == ConnectionState.DISCONNECTED) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Text("Getting Started", style = MaterialTheme.typography.titleMedium)
                        Spacer(modifier = Modifier.height(8.dp))
                        listOf(
                            "Open CoWork on your Mac",
                            "Go to Settings > Control Plane",
                            "Enable the Control Plane and copy the token",
                            "Tap Settings above to enter connection details",
                            "Ensure both devices are on the same network"
                        ).forEachIndexed { index, text ->
                            Row(modifier = Modifier.padding(vertical = 4.dp)) {
                                Text(
                                    "${index + 1}",
                                    style = MaterialTheme.typography.labelSmall,
                                    modifier = Modifier
                                        .clip(CircleShape)
                                        .background(MaterialTheme.colorScheme.primaryContainer)
                                        .padding(horizontal = 6.dp, vertical = 2.dp)
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Text(text, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(connection: CoWorkConnection, onBack: () -> Unit) {
    var host by remember { mutableStateOf(connection.serverHost) }
    var port by remember { mutableStateOf(connection.serverPort.toString()) }
    var token by remember { mutableStateOf(connection.token) }
    var autoReconnect by remember { mutableStateOf(connection.autoReconnect) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = {
                        // Save settings
                        connection.serverHost = host
                        connection.serverPort = port.toIntOrNull() ?: 18789
                        connection.token = token
                        connection.autoReconnect = autoReconnect
                        onBack()
                    }) {
                        Text("Back") // Replace with Icon in production
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Text("Server", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = host,
                onValueChange = { host = it },
                label = { Text("Host") },
                placeholder = { Text("192.168.1.100") },
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                singleLine = true
            )
            OutlinedTextField(
                value = port,
                onValueChange = { port = it },
                label = { Text("Port") },
                placeholder = { Text("18789") },
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                singleLine = true
            )

            Spacer(modifier = Modifier.height(8.dp))
            Text("Authentication", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = token,
                onValueChange = { token = it },
                label = { Text("Token") },
                placeholder = { Text("Paste token here") },
                modifier = Modifier.fillMaxWidth(),
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true
            )

            Spacer(modifier = Modifier.height(8.dp))
            Text("Connection", style = MaterialTheme.typography.titleMedium)
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("Auto-reconnect")
                Switch(checked = autoReconnect, onCheckedChange = { autoReconnect = it })
            }
        }
    }
}
