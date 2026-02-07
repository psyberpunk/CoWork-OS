/**
 * Control Plane IPC Handlers
 *
 * IPC handlers for managing the WebSocket control plane from the renderer.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS, TEMP_WORKSPACE_ID } from '../../shared/types';
import type {
  ControlPlaneSettingsData,
  ControlPlaneStatus,
  TailscaleAvailability,
  TailscaleMode,
  RemoteGatewayConfig,
  RemoteGatewayStatus,
  SSHTunnelConfig,
  SSHTunnelStatus,
} from '../../shared/types';
import { ControlPlaneServer, ControlPlaneSettingsManager } from './index';
import { Methods, Events, ErrorCodes } from './protocol';
import type { AgentConfig } from '../../shared/types';
import type { AgentDaemon } from '../agent/daemon';
import type { DatabaseManager } from '../database/schema';
import { TaskRepository, WorkspaceRepository } from '../database/repositories';
import { checkTailscaleAvailability, getExposureStatus } from '../tailscale';
import { TailscaleSettingsManager } from '../tailscale/settings';
import {
  RemoteGatewayClient,
  initRemoteGatewayClient,
  getRemoteGatewayClient,
  shutdownRemoteGatewayClient,
} from './remote-client';
import {
  SSHTunnelManager,
  initSSHTunnelManager,
  getSSHTunnelManager,
  shutdownSSHTunnelManager,
} from './ssh-tunnel';

// Server instance
let controlPlaneServer: ControlPlaneServer | null = null;

// Reference to main window for sending events
let mainWindowRef: BrowserWindow | null = null;

export interface ControlPlaneMethodDeps {
  agentDaemon: AgentDaemon;
  dbManager: DatabaseManager;
}

let controlPlaneDeps: ControlPlaneMethodDeps | null = null;
let detachAgentDaemonBridge: (() => void) | null = null;

/**
 * Get the current control plane server instance
 */
export function getControlPlaneServer(): ControlPlaneServer | null {
  return controlPlaneServer;
}

function requireScope(client: any, scope: 'admin' | 'read' | 'write' | 'operator'): void {
  if (!client?.hasScope?.(scope)) {
    throw { code: ErrorCodes.UNAUTHORIZED, message: `Missing required scope: ${scope}` };
  }
}

function sanitizeTaskCreateParams(params: unknown): {
  title: string;
  prompt: string;
  workspaceId: string;
  assignedAgentRoleId?: string;
  agentConfig?: AgentConfig;
  budgetTokens?: number;
  budgetCost?: number;
} {
  const p = (params ?? {}) as any;
  const title = typeof p.title === 'string' ? p.title.trim() : '';
  const prompt = typeof p.prompt === 'string' ? p.prompt.trim() : '';
  const workspaceId = typeof p.workspaceId === 'string' ? p.workspaceId.trim() : '';
  const assignedAgentRoleId = typeof p.assignedAgentRoleId === 'string' ? p.assignedAgentRoleId.trim() : '';

  const budgetTokens =
    typeof p.budgetTokens === 'number' && Number.isFinite(p.budgetTokens) ? Math.max(0, Math.floor(p.budgetTokens)) : undefined;
  const budgetCost =
    typeof p.budgetCost === 'number' && Number.isFinite(p.budgetCost) ? Math.max(0, p.budgetCost) : undefined;

  const agentConfig: AgentConfig | undefined = (() => {
    if (!p.agentConfig || typeof p.agentConfig !== 'object') return undefined;
    return p.agentConfig as AgentConfig;
  })();

  if (!title) throw { code: ErrorCodes.INVALID_PARAMS, message: 'title is required' };
  if (!prompt) throw { code: ErrorCodes.INVALID_PARAMS, message: 'prompt is required' };
  if (!workspaceId) throw { code: ErrorCodes.INVALID_PARAMS, message: 'workspaceId is required' };

  return {
    title,
    prompt,
    workspaceId,
    ...(assignedAgentRoleId ? { assignedAgentRoleId } : {}),
    ...(agentConfig ? { agentConfig } : {}),
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    ...(budgetCost !== undefined ? { budgetCost } : {}),
  };
}

function sanitizeTaskIdParams(params: unknown): { taskId: string } {
  const p = (params ?? {}) as any;
  const taskId = typeof p.taskId === 'string' ? p.taskId.trim() : '';
  if (!taskId) throw { code: ErrorCodes.INVALID_PARAMS, message: 'taskId is required' };
  return { taskId };
}

function sanitizeTaskMessageParams(params: unknown): { taskId: string; message: string } {
  const p = (params ?? {}) as any;
  const taskId = typeof p.taskId === 'string' ? p.taskId.trim() : '';
  const message = typeof p.message === 'string' ? p.message.trim() : '';
  if (!taskId) throw { code: ErrorCodes.INVALID_PARAMS, message: 'taskId is required' };
  if (!message) throw { code: ErrorCodes.INVALID_PARAMS, message: 'message is required' };
  return { taskId, message };
}

function sanitizeTaskListParams(params: unknown): { limit: number; offset: number; workspaceId?: string } {
  const p = (params ?? {}) as any;
  const rawLimit = typeof p.limit === 'number' && Number.isFinite(p.limit) ? Math.floor(p.limit) : 100;
  const rawOffset = typeof p.offset === 'number' && Number.isFinite(p.offset) ? Math.floor(p.offset) : 0;
  const limit = Math.min(Math.max(rawLimit, 1), 500);
  const offset = Math.max(rawOffset, 0);
  const workspaceId = typeof p.workspaceId === 'string' ? p.workspaceId.trim() : '';
  return { limit, offset, ...(workspaceId ? { workspaceId } : {}) };
}

function sanitizeWorkspaceIdParams(params: unknown): { workspaceId: string } {
  const p = (params ?? {}) as any;
  const workspaceId = typeof p.workspaceId === 'string' ? p.workspaceId.trim() : '';
  if (!workspaceId) throw { code: ErrorCodes.INVALID_PARAMS, message: 'workspaceId is required' };
  return { workspaceId };
}

const MAX_BROADCAST_STRING_CHARS = 2000;
const MAX_BROADCAST_ARRAY_ITEMS = 50;
const MAX_BROADCAST_OBJECT_KEYS = 50;
const MAX_BROADCAST_DEPTH = 3;
const SENSITIVE_KEY_RE = /(token|api[_-]?key|secret|password|authorization)/i;

function truncateForBroadcast(value: string): string {
  if (value.length <= MAX_BROADCAST_STRING_CHARS) return value;
  return value.slice(0, MAX_BROADCAST_STRING_CHARS) + `\n\n[... truncated (${value.length} chars) ...]`;
}

const ALWAYS_REDACT_KEY_RE = /^(prompt|systemPrompt)$/i;

function truncateForBroadcastKey(value: string, key?: string): string {
  // Allow longer message bodies, but keep other fields short by default.
  const maxChars = key === 'message' ? 12000 : MAX_BROADCAST_STRING_CHARS;
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + `\n\n[... truncated (${value.length} chars) ...]`;
}

function sanitizeForBroadcast(value: unknown, depth = 0, key?: string): unknown {
  if (depth > MAX_BROADCAST_DEPTH) {
    return '[... truncated ...]';
  }

  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateForBroadcastKey(value, key);
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    const next = value
      .slice(0, MAX_BROADCAST_ARRAY_ITEMS)
      .map((item) => sanitizeForBroadcast(item, depth + 1));
    if (value.length > MAX_BROADCAST_ARRAY_ITEMS) {
      next.push(`[... ${value.length - MAX_BROADCAST_ARRAY_ITEMS} more items truncated ...]`);
    }
    return next;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const out: Record<string, unknown> = {};

    for (const key of keys.slice(0, MAX_BROADCAST_OBJECT_KEYS)) {
      if (ALWAYS_REDACT_KEY_RE.test(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = sanitizeForBroadcast(obj[key], depth + 1, key);
    }

    if (keys.length > MAX_BROADCAST_OBJECT_KEYS) {
      out.__truncated_keys__ = keys.length - MAX_BROADCAST_OBJECT_KEYS;
    }

    return out;
  }

  try {
    return truncateForBroadcast(String(value));
  } catch {
    return '[unserializable]';
  }
}

function attachAgentDaemonTaskBridge(server: ControlPlaneServer, daemon: AgentDaemon): () => void {
  // Avoid broadcasting tool_result blobs by default; remote clients can fetch details via task.get if needed.
  const allowlist = [
    'task_created',
    'task_queued',
    'task_dequeued',
    'task_paused',
    'task_resumed',
    'task_cancelled',
    'task_completed',
    'plan_created',
    'plan_revised',
    'assistant_message',
    'user_message',
    'progress_update',
    'approval_requested',
    'approval_granted',
    'approval_denied',
    'step_started',
    'step_completed',
    'step_failed',
    'tool_call',
    'tool_error',
    'verification_passed',
    'verification_failed',
    'file_created',
    'file_modified',
    'file_deleted',
    'error',
    'llm_error',
    'step_timeout',
  ] as const;

  const unsubscribes: Array<() => void> = [];

  for (const eventType of allowlist) {
    const handler = (evt: any) => {
      try {
        const taskId = typeof evt?.taskId === 'string' ? evt.taskId : '';
        if (!taskId) return;

        const payload = { ...evt };
        delete payload.taskId;

        // Avoid leaking full prompts in broadcast; clients can call task.get if needed.
        if (eventType === 'task_created' && payload?.task && typeof payload.task === 'object') {
          const t = payload.task as any;
          payload.task = {
            id: t.id,
            title: t.title,
            status: t.status,
            workspaceId: t.workspaceId,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
            completedAt: t.completedAt,
            parentTaskId: t.parentTaskId,
            agentType: t.agentType,
            depth: t.depth,
            resultSummary: t.resultSummary,
            error: t.error,
            assignedAgentRoleId: t.assignedAgentRoleId,
            boardColumn: t.boardColumn,
            priority: t.priority,
          };
        }

        if (eventType === 'assistant_message' && typeof payload?.message === 'string' && payload.message.length > 12000) {
          payload.message = payload.message.slice(0, 12000) + '\n\n[... truncated for control-plane broadcast ...]';
        }

        if (eventType === 'tool_call' && payload?.input !== undefined) {
          payload.input = sanitizeForBroadcast(payload.input);
        }

        const sanitizedPayload = sanitizeForBroadcast(payload);

        server.broadcastToOperators(Events.TASK_EVENT, {
          taskId,
          type: eventType,
          payload: sanitizedPayload,
          timestamp: Date.now(),
        });
      } catch (error) {
        console.error('[ControlPlane] Failed to broadcast task event:', error);
      }
    };

    daemon.on(eventType, handler);
    unsubscribes.push(() => daemon.off(eventType, handler));
  }

  return () => {
    for (const off of unsubscribes) off();
  };
}

function registerTaskAndWorkspaceMethods(server: ControlPlaneServer, deps: ControlPlaneMethodDeps): void {
  const db = deps.dbManager.getDatabase();
  const taskRepo = new TaskRepository(db);
  const workspaceRepo = new WorkspaceRepository(db);
  const agentDaemon = deps.agentDaemon;
  const isAdminClient = (client: any) => !!client?.hasScope?.('admin');

  const redactWorkspaceForRead = (workspace: any) => ({
    id: workspace.id,
    name: workspace.name,
    createdAt: workspace.createdAt,
    lastUsedAt: workspace.lastUsedAt,
  });

  const redactTaskForRead = (task: any) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    workspaceId: task.workspaceId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    parentTaskId: task.parentTaskId,
    agentType: task.agentType,
    depth: task.depth,
    assignedAgentRoleId: task.assignedAgentRoleId,
    boardColumn: task.boardColumn,
    priority: task.priority,
    labels: task.labels,
    dueDate: task.dueDate,
  });

  // Workspaces
  server.registerMethod(Methods.WORKSPACE_LIST, async (client) => {
    requireScope(client, 'read');
    const all = workspaceRepo.findAll();
    const workspaces = all.filter((w) => w.id !== TEMP_WORKSPACE_ID);
    return {
      workspaces: isAdminClient(client) ? workspaces : workspaces.map(redactWorkspaceForRead),
    };
  });

  server.registerMethod(Methods.WORKSPACE_GET, async (client, params) => {
    requireScope(client, 'read');
    const { workspaceId } = sanitizeWorkspaceIdParams(params);
    const workspace = workspaceRepo.findById(workspaceId);
    if (!workspace) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Workspace not found: ${workspaceId}` };
    }
    return { workspace: isAdminClient(client) ? workspace : redactWorkspaceForRead(workspace) };
  });

  // Tasks
  server.registerMethod(Methods.TASK_CREATE, async (client, params) => {
    requireScope(client, 'admin');
    const validated = sanitizeTaskCreateParams(params);

    const workspace = workspaceRepo.findById(validated.workspaceId);
    if (!workspace) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Workspace not found: ${validated.workspaceId}` };
    }

    // Create task record
    const task = taskRepo.create({
      title: validated.title,
      prompt: validated.prompt,
      status: 'pending',
      workspaceId: validated.workspaceId,
      agentConfig: validated.agentConfig,
      budgetTokens: validated.budgetTokens,
      budgetCost: validated.budgetCost,
    });

    // Apply assignment metadata (update DB + in-memory object before starting).
    const initialUpdates: any = {};
    if (validated.assignedAgentRoleId) {
      initialUpdates.assignedAgentRoleId = validated.assignedAgentRoleId;
      initialUpdates.boardColumn = 'todo';
    }
    if (Object.keys(initialUpdates).length > 0) {
      taskRepo.update(task.id, initialUpdates);
      Object.assign(task, initialUpdates);
    }

    if (validated.workspaceId !== TEMP_WORKSPACE_ID) {
      try {
        workspaceRepo.updateLastUsedAt(validated.workspaceId);
      } catch (error) {
        console.warn('[ControlPlane] Failed to update workspace last used time:', error);
      }
    }

    try {
      await agentDaemon.startTask(task);
    } catch (error: any) {
      taskRepo.update(task.id, {
        status: 'failed',
        error: error?.message || 'Failed to start task',
        completedAt: Date.now(),
      });
      throw {
        code: ErrorCodes.METHOD_FAILED,
        message: error?.message || 'Failed to start task. Check LLM provider settings.',
      };
    }

    return { taskId: task.id, task };
  });

  server.registerMethod(Methods.TASK_GET, async (client, params) => {
    requireScope(client, 'read');
    const { taskId } = sanitizeTaskIdParams(params);
    const task = taskRepo.findById(taskId);
    if (!task) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Task not found: ${taskId}` };
    }
    return { task: isAdminClient(client) ? task : redactTaskForRead(task) };
  });

  server.registerMethod(Methods.TASK_LIST, async (client, params) => {
    requireScope(client, 'read');
    const { limit, offset, workspaceId } = sanitizeTaskListParams(params);

    if (workspaceId) {
      const total = taskRepo.countByWorkspace(workspaceId);
      const tasks = taskRepo.findByWorkspace(workspaceId, limit, offset);
      return {
        tasks: isAdminClient(client) ? tasks : tasks.map(redactTaskForRead),
        total,
        limit,
        offset,
      };
    }

    const tasks = taskRepo.findAll(limit, offset);
    return { tasks: isAdminClient(client) ? tasks : tasks.map(redactTaskForRead), limit, offset };
  });

  server.registerMethod(Methods.TASK_CANCEL, async (client, params) => {
    requireScope(client, 'admin');
    const { taskId } = sanitizeTaskIdParams(params);
    await agentDaemon.cancelTask(taskId);
    return { ok: true };
  });

  server.registerMethod(Methods.TASK_SEND_MESSAGE, async (client, params) => {
    requireScope(client, 'admin');
    const { taskId, message } = sanitizeTaskMessageParams(params);
    await agentDaemon.sendMessage(taskId, message);
    return { ok: true };
  });
}

/**
 * Initialize control plane IPC handlers
 */
export function setupControlPlaneHandlers(mainWindow: BrowserWindow, deps?: ControlPlaneMethodDeps): void {
  mainWindowRef = mainWindow;
  controlPlaneDeps = deps ?? null;

  // Initialize settings managers
  ControlPlaneSettingsManager.initialize();
  TailscaleSettingsManager.initialize();

  // Get settings (with masked token)
  ipcMain.handle(IPC_CHANNELS.CONTROL_PLANE_GET_SETTINGS, async (): Promise<ControlPlaneSettingsData> => {
    return ControlPlaneSettingsManager.getSettingsForDisplay();
  });

  // Save settings
  ipcMain.handle(
    IPC_CHANNELS.CONTROL_PLANE_SAVE_SETTINGS,
    async (_, settings: Partial<ControlPlaneSettingsData>): Promise<{ ok: boolean; error?: string }> => {
      try {
        ControlPlaneSettingsManager.updateSettings(settings);
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    }
  );

  // Enable control plane
  ipcMain.handle(IPC_CHANNELS.CONTROL_PLANE_ENABLE, async (): Promise<{
    ok: boolean;
    token?: string;
    error?: string;
  }> => {
    try {
      const settings = ControlPlaneSettingsManager.enable();
      return { ok: true, token: settings.token };
    } catch (error: any) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  // Disable control plane
  ipcMain.handle(IPC_CHANNELS.CONTROL_PLANE_DISABLE, async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      // Stop server if running
      if (controlPlaneServer) {
        if (detachAgentDaemonBridge) {
          detachAgentDaemonBridge();
          detachAgentDaemonBridge = null;
        }
        await controlPlaneServer.stop();
        controlPlaneServer = null;
      }
      ControlPlaneSettingsManager.disable();
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  // Start control plane server
  ipcMain.handle(IPC_CHANNELS.CONTROL_PLANE_START, async (): Promise<{
    ok: boolean;
    address?: { host: string; port: number; wsUrl: string };
    tailscale?: { httpsUrl?: string; wssUrl?: string };
    error?: string;
  }> => {
    try {
      if (controlPlaneServer?.isRunning) {
        const addr = controlPlaneServer.getAddress();
        const tailscale = getExposureStatus();
        return {
          ok: true,
          address: addr || undefined,
          tailscale: tailscale.active ? {
            httpsUrl: tailscale.httpsUrl,
            wssUrl: tailscale.wssUrl,
          } : undefined,
        };
      }

      // Cleanup a previous failed/partial server instance.
      if (controlPlaneServer && !controlPlaneServer.isRunning) {
        if (detachAgentDaemonBridge) {
          detachAgentDaemonBridge();
          detachAgentDaemonBridge = null;
        }
        controlPlaneServer = null;
      }

      const settings = ControlPlaneSettingsManager.loadSettings();

      if (!settings.token) {
        return { ok: false, error: 'No authentication token configured' };
      }

      // Create server instance
      const server = new ControlPlaneServer({
        port: settings.port,
        host: settings.host,
        token: settings.token,
        handshakeTimeoutMs: settings.handshakeTimeoutMs,
        heartbeatIntervalMs: settings.heartbeatIntervalMs,
        maxPayloadBytes: settings.maxPayloadBytes,
        onEvent: (event) => {
          // Forward events to renderer
          if (mainWindowRef && !mainWindowRef.isDestroyed()) {
            mainWindowRef.webContents.send(IPC_CHANNELS.CONTROL_PLANE_EVENT, event);
          }
        },
      });
      controlPlaneServer = server;

      try {
        // Register task/workspace methods + event bridge (enables multi-Mac orchestration).
        if (controlPlaneDeps) {
          registerTaskAndWorkspaceMethods(server, controlPlaneDeps);
          detachAgentDaemonBridge = attachAgentDaemonTaskBridge(server, controlPlaneDeps.agentDaemon);
        } else {
          console.warn('[ControlPlane] No deps provided; task/workspace methods are disabled');
        }

        // Start with Tailscale if configured
        const tailscaleResult = await server.startWithTailscale();

        const address = server.getAddress();

        return {
          ok: true,
          address: address || undefined,
          tailscale: tailscaleResult?.success ? {
            httpsUrl: tailscaleResult.httpsUrl,
            wssUrl: tailscaleResult.wssUrl,
          } : undefined,
        };
      } catch (error) {
        if (detachAgentDaemonBridge) {
          detachAgentDaemonBridge();
          detachAgentDaemonBridge = null;
        }
        try {
          await server.stop();
        } catch (stopError) {
          console.error('[ControlPlane] Failed to cleanup server after start error:', stopError);
        }
        if (controlPlaneServer === server) {
          controlPlaneServer = null;
        }
        throw error;
      }
    } catch (error: any) {
      console.error('[ControlPlane Handlers] Start error:', error);
      return { ok: false, error: error.message || String(error) };
    }
  });

  // Stop control plane server
  ipcMain.handle(IPC_CHANNELS.CONTROL_PLANE_STOP, async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      if (controlPlaneServer) {
        if (detachAgentDaemonBridge) {
          detachAgentDaemonBridge();
          detachAgentDaemonBridge = null;
        }
        await controlPlaneServer.stop();
        controlPlaneServer = null;
      }
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  // Get control plane status
  ipcMain.handle(IPC_CHANNELS.CONTROL_PLANE_GET_STATUS, async (): Promise<ControlPlaneStatus> => {
    const settings = ControlPlaneSettingsManager.loadSettings();
    const tailscale = getExposureStatus();

    if (!controlPlaneServer || !controlPlaneServer.isRunning) {
      return {
        enabled: settings.enabled,
        running: false,
        clients: {
          total: 0,
          authenticated: 0,
          pending: 0,
          list: [],
        },
        tailscale: {
          active: tailscale.active,
          mode: tailscale.mode,
          hostname: tailscale.hostname,
          httpsUrl: tailscale.httpsUrl,
          wssUrl: tailscale.wssUrl,
        },
      };
    }

    const serverStatus = controlPlaneServer.getStatus();

    return {
      enabled: settings.enabled,
      running: serverStatus.running,
      address: serverStatus.address || undefined,
      clients: {
        total: serverStatus.clients.total,
        authenticated: serverStatus.clients.authenticated,
        pending: serverStatus.clients.pending,
        list: serverStatus.clients.clients,
      },
      tailscale: {
        active: serverStatus.tailscale.active,
        mode: serverStatus.tailscale.mode,
        hostname: serverStatus.tailscale.hostname,
        httpsUrl: serverStatus.tailscale.httpsUrl,
        wssUrl: serverStatus.tailscale.wssUrl,
      },
    };
  });

  // Regenerate token
  ipcMain.handle(IPC_CHANNELS.CONTROL_PLANE_REGENERATE_TOKEN, async (): Promise<{
    ok: boolean;
    token?: string;
    error?: string;
  }> => {
    try {
      const newToken = ControlPlaneSettingsManager.regenerateToken();

      // If server is running, we need to restart it with new token
      if (controlPlaneServer?.isRunning) {
        if (detachAgentDaemonBridge) {
          detachAgentDaemonBridge();
          detachAgentDaemonBridge = null;
        }
        await controlPlaneServer.stop();
        const settings = ControlPlaneSettingsManager.loadSettings();

        controlPlaneServer = new ControlPlaneServer({
          port: settings.port,
          host: settings.host,
          token: settings.token,
          handshakeTimeoutMs: settings.handshakeTimeoutMs,
          heartbeatIntervalMs: settings.heartbeatIntervalMs,
          maxPayloadBytes: settings.maxPayloadBytes,
          onEvent: (event) => {
            if (mainWindowRef && !mainWindowRef.isDestroyed()) {
              mainWindowRef.webContents.send(IPC_CHANNELS.CONTROL_PLANE_EVENT, event);
            }
          },
        });

        if (controlPlaneDeps) {
          registerTaskAndWorkspaceMethods(controlPlaneServer, controlPlaneDeps);
          detachAgentDaemonBridge = attachAgentDaemonTaskBridge(controlPlaneServer, controlPlaneDeps.agentDaemon);
        }

        await controlPlaneServer.startWithTailscale();
      }

      return { ok: true, token: newToken };
    } catch (error: any) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  // ===== Tailscale Handlers =====

  // Check Tailscale availability
  ipcMain.handle(IPC_CHANNELS.TAILSCALE_CHECK_AVAILABILITY, async (): Promise<TailscaleAvailability> => {
    return await checkTailscaleAvailability();
  });

  // Get Tailscale status
  ipcMain.handle(IPC_CHANNELS.TAILSCALE_GET_STATUS, async () => {
    const settings = TailscaleSettingsManager.loadSettings();
    const exposure = getExposureStatus();

    return {
      settings,
      exposure,
    };
  });

  // Set Tailscale mode
  ipcMain.handle(
    IPC_CHANNELS.TAILSCALE_SET_MODE,
    async (_, mode: TailscaleMode): Promise<{ ok: boolean; error?: string }> => {
      try {
        // Update settings
        ControlPlaneSettingsManager.updateSettings({
          tailscale: { mode, resetOnExit: true },
        });

        // If server is running, restart to apply new mode
        if (controlPlaneServer?.isRunning) {
          if (detachAgentDaemonBridge) {
            detachAgentDaemonBridge();
            detachAgentDaemonBridge = null;
          }
          await controlPlaneServer.stop();
          const settings = ControlPlaneSettingsManager.loadSettings();

          controlPlaneServer = new ControlPlaneServer({
            port: settings.port,
            host: settings.host,
            token: settings.token,
            handshakeTimeoutMs: settings.handshakeTimeoutMs,
            heartbeatIntervalMs: settings.heartbeatIntervalMs,
            maxPayloadBytes: settings.maxPayloadBytes,
            onEvent: (event) => {
              if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                mainWindowRef.webContents.send(IPC_CHANNELS.CONTROL_PLANE_EVENT, event);
              }
            },
          });

          if (controlPlaneDeps) {
            registerTaskAndWorkspaceMethods(controlPlaneServer, controlPlaneDeps);
            detachAgentDaemonBridge = attachAgentDaemonTaskBridge(controlPlaneServer, controlPlaneDeps.agentDaemon);
          }

          await controlPlaneServer.startWithTailscale();
        }

        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    }
  );

  // ===== Remote Gateway Handlers =====

  // Connect to remote gateway
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_GATEWAY_CONNECT,
    async (_, config?: RemoteGatewayConfig): Promise<{ ok: boolean; error?: string }> => {
      try {
        // Get config from settings if not provided
        const settings = ControlPlaneSettingsManager.loadSettings();
        const remoteConfig = config || settings.remote;

        if (!remoteConfig?.url || !remoteConfig?.token) {
          return { ok: false, error: 'Remote gateway URL and token are required' };
        }

        // Stop local server if running
        if (controlPlaneServer?.isRunning) {
          if (detachAgentDaemonBridge) {
            detachAgentDaemonBridge();
            detachAgentDaemonBridge = null;
          }
          await controlPlaneServer.stop();
          controlPlaneServer = null;
        }

        // Initialize and connect remote client
        const client = initRemoteGatewayClient({
          ...remoteConfig,
          onStateChange: (state, error) => {
            if (mainWindowRef && !mainWindowRef.isDestroyed()) {
              mainWindowRef.webContents.send(IPC_CHANNELS.REMOTE_GATEWAY_EVENT, {
                type: 'stateChange',
                state,
                error,
              });
            }
          },
          onEvent: (event, payload) => {
            if (mainWindowRef && !mainWindowRef.isDestroyed()) {
              mainWindowRef.webContents.send(IPC_CHANNELS.REMOTE_GATEWAY_EVENT, {
                type: 'event',
                event,
                payload,
              });
            }
          },
        });

        await client.connect();

        // Update settings with connection mode
        ControlPlaneSettingsManager.updateSettings({
          connectionMode: 'remote',
          remote: remoteConfig,
        });

        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    }
  );

  // Disconnect from remote gateway
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_GATEWAY_DISCONNECT,
    async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        shutdownRemoteGatewayClient();
        ControlPlaneSettingsManager.updateSettings({
          connectionMode: 'local',
        });
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    }
  );

  // Get remote gateway status
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_GATEWAY_GET_STATUS,
    async (): Promise<RemoteGatewayStatus> => {
      const client = getRemoteGatewayClient();
      const tunnel = getSSHTunnelManager();

      if (!client) {
        return {
          state: 'disconnected',
          sshTunnel: tunnel?.getStatus(),
        };
      }

      const status = client.getStatus();
      return {
        ...status,
        sshTunnel: tunnel?.getStatus(),
      };
    }
  );

  // Save remote gateway config
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_GATEWAY_SAVE_CONFIG,
    async (_, config: RemoteGatewayConfig): Promise<{ ok: boolean; error?: string }> => {
      try {
        ControlPlaneSettingsManager.updateSettings({
          remote: config,
        });
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    }
  );

  // Test remote gateway connection
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_GATEWAY_TEST_CONNECTION,
    async (_, config: RemoteGatewayConfig): Promise<{
      ok: boolean;
      latencyMs?: number;
      error?: string;
    }> => {
      try {
        const client = new RemoteGatewayClient(config);
        const result = await client.testConnection();
        return {
          ok: result.success,
          latencyMs: result.latencyMs,
          error: result.error,
        };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    }
  );

  // ===== SSH Tunnel Handlers =====

  // Connect SSH tunnel
  ipcMain.handle(
    IPC_CHANNELS.SSH_TUNNEL_CONNECT,
    async (_, config?: SSHTunnelConfig): Promise<{ ok: boolean; error?: string }> => {
      try {
        // Get config from settings if not provided
        const settings = ControlPlaneSettingsManager.loadSettings();
        const tunnelConfig = config || settings.remote?.sshTunnel;

        if (!tunnelConfig?.host || !tunnelConfig?.username) {
          return { ok: false, error: 'SSH host and username are required' };
        }

        // Initialize and connect SSH tunnel
        const tunnel = initSSHTunnelManager({
          ...tunnelConfig,
          enabled: true,
        });

        // Setup event forwarding to renderer
        tunnel.on('stateChange', (state: string, error?: string) => {
          if (mainWindowRef && !mainWindowRef.isDestroyed()) {
            mainWindowRef.webContents.send(IPC_CHANNELS.SSH_TUNNEL_EVENT, {
              type: 'stateChange',
              state,
              error,
            });
          }
        });

        tunnel.on('connected', () => {
          if (mainWindowRef && !mainWindowRef.isDestroyed()) {
            mainWindowRef.webContents.send(IPC_CHANNELS.SSH_TUNNEL_EVENT, {
              type: 'connected',
            });
          }
        });

        tunnel.on('disconnected', (reason: string) => {
          if (mainWindowRef && !mainWindowRef.isDestroyed()) {
            mainWindowRef.webContents.send(IPC_CHANNELS.SSH_TUNNEL_EVENT, {
              type: 'disconnected',
              reason,
            });
          }
        });

        tunnel.on('error', (error: Error) => {
          if (mainWindowRef && !mainWindowRef.isDestroyed()) {
            mainWindowRef.webContents.send(IPC_CHANNELS.SSH_TUNNEL_EVENT, {
              type: 'error',
              error: error.message,
            });
          }
        });

        await tunnel.connect();

        // Save SSH tunnel config to settings
        if (config) {
          ControlPlaneSettingsManager.updateSettings({
            remote: {
              ...settings.remote,
              url: tunnel.getLocalUrl(),
              token: settings.remote?.token || '',
              sshTunnel: config,
            } as any,
          });
        }

        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    }
  );

  // Disconnect SSH tunnel
  ipcMain.handle(
    IPC_CHANNELS.SSH_TUNNEL_DISCONNECT,
    async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        shutdownSSHTunnelManager();
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    }
  );

  // Get SSH tunnel status
  ipcMain.handle(
    IPC_CHANNELS.SSH_TUNNEL_GET_STATUS,
    async (): Promise<SSHTunnelStatus> => {
      const tunnel = getSSHTunnelManager();
      if (!tunnel) {
        return { state: 'disconnected' };
      }
      return tunnel.getStatus();
    }
  );

  // Save SSH tunnel config
  ipcMain.handle(
    IPC_CHANNELS.SSH_TUNNEL_SAVE_CONFIG,
    async (_, config: SSHTunnelConfig): Promise<{ ok: boolean; error?: string }> => {
      try {
        const settings = ControlPlaneSettingsManager.loadSettings();
        ControlPlaneSettingsManager.updateSettings({
          remote: {
            ...settings.remote,
            url: settings.remote?.url || '',
            token: settings.remote?.token || '',
            sshTunnel: config,
          } as any,
        });
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    }
  );

  // Test SSH tunnel connection
  ipcMain.handle(
    IPC_CHANNELS.SSH_TUNNEL_TEST_CONNECTION,
    async (_, config: SSHTunnelConfig): Promise<{
      ok: boolean;
      latencyMs?: number;
      error?: string;
    }> => {
      try {
        const tunnel = new SSHTunnelManager(config);
        const result = await tunnel.testConnection();
        return {
          ok: result.success,
          latencyMs: result.latencyMs,
          error: result.error,
        };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    }
  );

  // ===== Node (Mobile Companion) Handlers =====

  // List connected nodes
  ipcMain.handle(IPC_CHANNELS.NODE_LIST, async (): Promise<{
    ok: boolean;
    nodes?: import('../../shared/types').NodeInfo[];
    error?: string;
  }> => {
    try {
      if (!controlPlaneServer || !controlPlaneServer.isRunning) {
        return { ok: true, nodes: [] };
      }
      const nodes = (controlPlaneServer as any).clients.getNodeInfoList();
      return { ok: true, nodes };
    } catch (error: any) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  // Get a specific node
  ipcMain.handle(
    IPC_CHANNELS.NODE_GET,
    async (_, nodeId: string): Promise<{
      ok: boolean;
      node?: import('../../shared/types').NodeInfo;
      error?: string;
    }> => {
      try {
        if (!controlPlaneServer || !controlPlaneServer.isRunning) {
          return { ok: false, error: 'Control Plane is not running' };
        }
        const client = (controlPlaneServer as any).clients.getNodeByIdOrName(nodeId);
        if (!client) {
          return { ok: false, error: `Node not found: ${nodeId}` };
        }
        return { ok: true, node: client.getNodeInfo() };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    }
  );

  // Invoke a command on a node
  ipcMain.handle(
    IPC_CHANNELS.NODE_INVOKE,
    async (_, params: import('../../shared/types').NodeInvokeParams): Promise<import('../../shared/types').NodeInvokeResult> => {
      try {
        if (!controlPlaneServer || !controlPlaneServer.isRunning) {
          return {
            ok: false,
            error: { code: 'SERVER_NOT_RUNNING', message: 'Control Plane is not running' },
          };
        }

        const { nodeId, command, params: commandParams, timeoutMs = 30000 } = params;

        // Find the node
        const client = (controlPlaneServer as any).clients.getNodeByIdOrName(nodeId);
        if (!client) {
          return {
            ok: false,
            error: { code: 'NODE_NOT_FOUND', message: `Node not found: ${nodeId}` },
          };
        }

        const nodeInfo = client.getNodeInfo();
        if (!nodeInfo) {
          return {
            ok: false,
            error: { code: 'NODE_NOT_FOUND', message: `Node not found: ${nodeId}` },
          };
        }

        // Check if node supports the command
        if (!nodeInfo.commands.includes(command)) {
          return {
            ok: false,
            error: {
              code: 'COMMAND_NOT_SUPPORTED',
              message: `Node does not support command: ${command}`,
            },
          };
        }

        // Forward to the server's internal method
        const result = await (controlPlaneServer as any).invokeNodeCommand(
          client,
          command,
          commandParams,
          timeoutMs
        );
        return result;
      } catch (error: any) {
        return {
          ok: false,
          error: { code: 'INVOKE_FAILED', message: error.message || String(error) },
        };
      }
    }
  );

  console.log('[ControlPlane] IPC handlers initialized');
}

/**
 * Shutdown the control plane server, remote client, and SSH tunnel
 * Call this during app quit
 */
export async function shutdownControlPlane(): Promise<void> {
  // Shutdown SSH tunnel
  shutdownSSHTunnelManager();

  // Shutdown remote client
  shutdownRemoteGatewayClient();

  // Shutdown local server
  if (controlPlaneServer) {
    console.log('[ControlPlane] Shutting down server...');
    if (detachAgentDaemonBridge) {
      detachAgentDaemonBridge();
      detachAgentDaemonBridge = null;
    }
    await controlPlaneServer.stop();
    controlPlaneServer = null;
  }
}
