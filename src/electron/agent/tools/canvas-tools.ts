/**
 * Canvas Tools
 *
 * Agent tools for interacting with Live Canvas visual workspace.
 * Enables the agent to:
 * - Create canvas sessions
 * - Push HTML/CSS/JS content
 * - Execute JavaScript in the canvas context
 * - Take snapshots of the canvas
 * - Show/hide/close canvas windows
 */

import { Workspace } from '../../../shared/types';
import { AgentDaemon } from '../daemon';
import { CanvasManager } from '../../canvas/canvas-manager';
import { LLMTool } from '../llm/types';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * CanvasTools provides agent capabilities for visual content rendering
 */
export class CanvasTools {
  private manager: CanvasManager;
  private sessionCutoff: number | null = null;

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string
  ) {
    this.manager = CanvasManager.getInstance();
  }

  /**
   * Set a cutoff timestamp for enforcing new canvas sessions on follow-ups.
   * Any canvas_push/open_url targeting sessions created before this cutoff will be rejected.
   */
  setSessionCutoff(cutoff: number | null): void {
    this.sessionCutoff = cutoff;
  }

  private enforceSessionCutoff(sessionId: string, action: 'canvas_push' | 'canvas_open_url'): void {
    if (!this.sessionCutoff) return;
    const session = this.manager.getSession(sessionId);
    if (!session) return;
    // Allow follow-up pushes to sessions created by the same task
    if (session.taskId === this.taskId) return;
    if (session.createdAt < this.sessionCutoff) {
      const message = 'Canvas session belongs to a previous run. Create a new session with canvas_create for follow-up content instead of reusing an older session.';
      console.error(`[CanvasTools] ${action} blocked for stale session. sessionId=${sessionId}, createdAt=${session.createdAt}, cutoff=${this.sessionCutoff}`);
      throw new Error(message);
    }
  }

  /**
   * Update the workspace for this tool
   */
  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  /**
   * Create a new canvas session
   */
  async createCanvas(title?: string): Promise<{
    sessionId: string;
    sessionDir: string;
  }> {
    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'canvas_create',
      title,
    });

    try {
      const session = await this.manager.createSession(
        this.taskId,
        this.workspace.id,
        title
      );

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'canvas_create',
        success: true,
        sessionId: session.id,
      });

      return {
        sessionId: session.id,
        sessionDir: session.sessionDir,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.daemon.logEvent(this.taskId, 'tool_error', {
        tool: 'canvas_create',
        error: message,
      });
      throw error;
    }
  }

  /**
   * Push content to the canvas
   */
  async pushContent(
    sessionId: string,
    content: string,
    filename: string = 'index.html'
  ): Promise<{ success: boolean }> {
    this.enforceSessionCutoff(sessionId, 'canvas_push');
    let resolvedContent = content;
    const defaultMarker = 'Waiting for content...';
    const contentProvided = typeof content === 'string' && content.trim().length > 0;

    // Validate content parameter; if missing, attempt to reuse existing canvas file
    if (resolvedContent === undefined || resolvedContent === null) {
      const session = this.manager.getSession(sessionId);
      if (session) {
        const safeFilename = path.basename(filename || 'index.html');
        const filePath = path.join(session.sessionDir, safeFilename);
        try {
          resolvedContent = await fs.readFile(filePath, 'utf-8');
          console.warn(`[CanvasTools] canvas_push missing content; reusing existing ${safeFilename} from session ${sessionId}`);
        } catch (error) {
          console.error(`[CanvasTools] Failed to read existing canvas content from ${filePath}:`, error);
        }
      }
    }

    // If we still have no content or only the default placeholder, try the most recent session for this task
    if (
      resolvedContent === undefined ||
      resolvedContent === null ||
      (typeof resolvedContent === 'string' && resolvedContent.includes(defaultMarker))
    ) {
      const otherSessions = this.manager
        .listSessionsForTask(this.taskId)
        .filter((s) => s.id !== sessionId && s.status === 'active')
        .sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));

      for (const session of otherSessions) {
        const safeFilename = path.basename(filename || 'index.html');
        const filePath = path.join(session.sessionDir, safeFilename);
        try {
          const candidate = await fs.readFile(filePath, 'utf-8');
          if (!candidate.includes(defaultMarker)) {
            resolvedContent = candidate;
            console.warn(`[CanvasTools] canvas_push missing content; copied ${safeFilename} from session ${session.id}`);
            break;
          }
        } catch (error) {
          console.error(`[CanvasTools] Failed to read canvas content from ${filePath}:`, error);
        }
      }
    }

    const isPlaceholder = typeof resolvedContent === 'string' && resolvedContent.includes(defaultMarker);

    if (!contentProvided && (resolvedContent === undefined || resolvedContent === null || isPlaceholder)) {
      console.error(
        `[CanvasTools] canvas_push called without content and no non-placeholder HTML found. sessionId=${sessionId}, filename=${filename}`
      );
      throw new Error(
        'Content parameter is required for canvas_push. The agent must provide HTML content to display.'
      );
    }

    if (resolvedContent === undefined || resolvedContent === null) {
      console.error(`[CanvasTools] canvas_push called without content. sessionId=${sessionId}, filename=${filename}, content type=${typeof content}`);
      throw new Error('Content parameter is required for canvas_push. The agent must provide HTML content to display.');
    }

    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'canvas_push',
      sessionId,
      filename,
      contentLength: resolvedContent.length,
    });

    try {
      await this.manager.pushContent(sessionId, resolvedContent, filename);

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'canvas_push',
        success: true,
      });

      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.daemon.logEvent(this.taskId, 'tool_error', {
        tool: 'canvas_push',
        error: message,
      });
      throw error;
    }
  }

  /**
   * Open a remote URL inside the canvas window (browser mode)
   */
  async openUrl(
    sessionId: string,
    url: string,
    show: boolean = true
  ): Promise<{ success: boolean; url: string }> {
    this.enforceSessionCutoff(sessionId, 'canvas_open_url');
    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'canvas_open_url',
      sessionId,
      url,
      show,
    });

    try {
      const normalizedUrl = await this.manager.openUrl(sessionId, url, { show });

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'canvas_open_url',
        success: true,
        url: normalizedUrl,
      });

      return { success: true, url: normalizedUrl };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.daemon.logEvent(this.taskId, 'tool_error', {
        tool: 'canvas_open_url',
        error: message,
      });
      throw error;
    }
  }

  /**
   * Show the canvas window
   */
  async showCanvas(sessionId: string): Promise<{ success: boolean }> {
    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'canvas_show',
      sessionId,
    });

    try {
      await this.manager.showCanvas(sessionId);

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'canvas_show',
        success: true,
      });

      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.daemon.logEvent(this.taskId, 'tool_error', {
        tool: 'canvas_show',
        error: message,
      });
      throw error;
    }
  }

  /**
   * Hide the canvas window
   */
  hideCanvas(sessionId: string): { success: boolean } {
    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'canvas_hide',
      sessionId,
    });

    try {
      this.manager.hideCanvas(sessionId);

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'canvas_hide',
        success: true,
      });

      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.daemon.logEvent(this.taskId, 'tool_error', {
        tool: 'canvas_hide',
        error: message,
      });
      throw error;
    }
  }

  /**
   * Close the canvas session
   */
  async closeCanvas(sessionId: string): Promise<{ success: boolean }> {
    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'canvas_close',
      sessionId,
    });

    try {
      await this.manager.closeSession(sessionId);

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'canvas_close',
        success: true,
      });

      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.daemon.logEvent(this.taskId, 'tool_error', {
        tool: 'canvas_close',
        error: message,
      });
      throw error;
    }
  }

  /**
   * Execute JavaScript in the canvas context
   */
  async evalScript(sessionId: string, script: string): Promise<{ result: unknown }> {
    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'canvas_eval',
      sessionId,
      scriptLength: script.length,
    });

    try {
      const result = await this.manager.evalScript(sessionId, script);

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'canvas_eval',
        success: true,
      });

      return { result };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.daemon.logEvent(this.taskId, 'tool_error', {
        tool: 'canvas_eval',
        error: message,
      });
      throw error;
    }
  }

  /**
   * Take a screenshot of the canvas
   */
  async takeSnapshot(sessionId: string): Promise<{
    imageBase64: string;
    width: number;
    height: number;
  }> {
    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'canvas_snapshot',
      sessionId,
    });

    try {
      const snapshot = await this.manager.takeSnapshot(sessionId);

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'canvas_snapshot',
        success: true,
        width: snapshot.width,
        height: snapshot.height,
      });

      return {
        imageBase64: snapshot.imageBase64,
        width: snapshot.width,
        height: snapshot.height,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.daemon.logEvent(this.taskId, 'tool_error', {
        tool: 'canvas_snapshot',
        error: message,
      });
      throw error;
    }
  }

  /**
   * Save a named checkpoint of the current canvas state
   */
  async saveCheckpoint(
    sessionId: string,
    label?: string
  ): Promise<{ checkpointId: string; label: string; fileCount: number }> {
    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'canvas_checkpoint',
      sessionId,
      label,
    });

    try {
      const checkpoint = await this.manager.saveCheckpoint(sessionId, label);

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'canvas_checkpoint',
        success: true,
        checkpointId: checkpoint.id,
      });

      return {
        checkpointId: checkpoint.id,
        label: checkpoint.label,
        fileCount: Object.keys(checkpoint.files).length,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.daemon.logEvent(this.taskId, 'tool_error', {
        tool: 'canvas_checkpoint',
        error: message,
      });
      throw error;
    }
  }

  /**
   * Restore canvas to a previously saved checkpoint
   */
  async restoreCheckpoint(
    sessionId: string,
    checkpointId: string
  ): Promise<{ success: boolean; label: string }> {
    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'canvas_restore',
      sessionId,
      checkpointId,
    });

    try {
      const checkpoint = await this.manager.restoreCheckpoint(sessionId, checkpointId);

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'canvas_restore',
        success: true,
        label: checkpoint.label,
      });

      return { success: true, label: checkpoint.label };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.daemon.logEvent(this.taskId, 'tool_error', {
        tool: 'canvas_restore',
        error: message,
      });
      throw error;
    }
  }

  /**
   * List checkpoints for a canvas session
   */
  listCheckpoints(sessionId: string): {
    checkpoints: Array<{
      id: string;
      label: string;
      createdAt: number;
    }>;
  } {
    const checkpoints = this.manager.listCheckpoints(sessionId);
    return {
      checkpoints: checkpoints.map((cp) => ({
        id: cp.id,
        label: cp.label,
        createdAt: cp.createdAt,
      })),
    };
  }

  /**
   * List all canvas sessions for the current task
   */
  listSessions(): {
    sessions: Array<{
      id: string;
      title?: string;
      status: string;
      createdAt: number;
    }>;
  } {
    const sessions = this.manager.listSessionsForTask(this.taskId);
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        createdAt: s.createdAt,
      })),
    };
  }

  /**
   * Static method to get tool definitions
   */
  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'canvas_create',
        description:
          'Create a new Live Canvas session for displaying interactive HTML/CSS/JS content. ' +
          'The canvas opens in a separate window where you can render visual content. ' +
          'Returns a session ID that you use for subsequent canvas operations. ' +
          'For new user requests or follow-ups, create a NEW session instead of reusing an older one unless the user explicitly asks to update the existing canvas.',
        input_schema: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'Optional title for the canvas window',
            },
          },
          required: [],
        },
      },
      {
        name: 'canvas_push',
        description:
          'Push HTML/CSS/JS content to a canvas session. ' +
          'You MUST provide both session_id and content parameters. ' +
          'The content parameter must be a complete HTML string (e.g., "<!DOCTYPE html><html><body>...</body></html>"). ' +
          'Use this to display interactive visualizations, forms, dashboards, or any web content. ' +
          'Do NOT overwrite an older session on follow-ups; create a new session with canvas_create unless explicitly asked to update the existing canvas.',
        input_schema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'The canvas session ID returned from canvas_create',
            },
            content: {
              type: 'string',
              description: 'REQUIRED: The complete HTML content to display. Must be a valid HTML string, e.g., "<!DOCTYPE html><html><head><style>body{background:#1a1a2e;color:#fff}</style></head><body><h1>Title</h1></body></html>"',
            },
            filename: {
              type: 'string',
              description: 'Filename to save (default: index.html). Use for CSS/JS files.',
            },
          },
          required: ['session_id', 'content'],
        },
      },
      {
        name: 'canvas_show',
        description:
          'OPTIONAL: Open the canvas in a separate interactive window. ' +
          'The in-app preview already shows your content automatically after canvas_push. ' +
          'Only use canvas_show when the user needs full interactivity (clicking buttons, filling forms, etc.)',
        input_schema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'The canvas session ID',
            },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'canvas_open_url',
        description:
          'Open a remote web page inside the canvas window for full in-app browsing. ' +
          'Use this for websites that cannot be embedded in iframes/webviews (to avoid blank screens). ' +
          'Pass show=true to open the interactive canvas window immediately.',
        input_schema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'The canvas session ID returned from canvas_create',
            },
            url: {
              type: 'string',
              description: 'The URL to open (http/https). If no scheme is provided, https:// will be used.',
            },
            show: {
              type: 'boolean',
              description: 'Whether to show the interactive canvas window immediately (default: true)',
            },
          },
          required: ['session_id', 'url'],
        },
      },
      {
        name: 'canvas_hide',
        description: 'Hide the canvas window without closing the session',
        input_schema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'The canvas session ID',
            },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'canvas_close',
        description: 'Close a canvas session and its window',
        input_schema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'The canvas session ID',
            },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'canvas_eval',
        description:
          'Execute JavaScript code in the canvas context. ' +
          'Use this to interact with the rendered content, read values, or trigger updates.',
        input_schema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'The canvas session ID',
            },
            script: {
              type: 'string',
              description: 'JavaScript code to execute in the canvas context',
            },
          },
          required: ['session_id', 'script'],
        },
      },
      {
        name: 'canvas_snapshot',
        description:
          'Take a screenshot of the canvas content. ' +
          'Returns a base64-encoded PNG image of the current visual state.',
        input_schema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'The canvas session ID',
            },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'canvas_list',
        description: 'List all active canvas sessions for the current task',
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'canvas_checkpoint',
        description:
          'Save a named checkpoint of the current canvas state. ' +
          'This captures all files in the session directory so you can restore to this exact state later. ' +
          'Useful before making experimental changes to the canvas content.',
        input_schema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'The canvas session ID',
            },
            label: {
              type: 'string',
              description: 'Optional human-readable label for this checkpoint (e.g., "before color changes")',
            },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'canvas_restore',
        description:
          'Restore a canvas session to a previously saved checkpoint. ' +
          'This reverts all files in the session directory to the checkpoint state and reloads the canvas.',
        input_schema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'The canvas session ID',
            },
            checkpoint_id: {
              type: 'string',
              description: 'The checkpoint ID to restore (from canvas_checkpoints)',
            },
          },
          required: ['session_id', 'checkpoint_id'],
        },
      },
      {
        name: 'canvas_checkpoints',
        description: 'List all saved checkpoints for a canvas session',
        input_schema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'The canvas session ID',
            },
          },
          required: ['session_id'],
        },
      },
    ];
  }
}
