import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  AgentRole,
  CreateAgentRoleRequest,
  UpdateAgentRoleRequest,
  AgentCapability,
  AgentToolRestrictions,
  DEFAULT_AGENT_ROLES,
} from '../../shared/types';

/**
 * Safely parse JSON with error handling
 */
function safeJsonParse<T>(jsonString: string | null, defaultValue: T, context?: string): T {
  if (!jsonString) return defaultValue;
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.error(`Failed to parse JSON${context ? ` in ${context}` : ''}:`, error);
    return defaultValue;
  }
}

/**
 * Repository for managing agent roles in the database
 */
export class AgentRoleRepository {
  constructor(private db: Database.Database) {}

  /**
   * Create a new agent role
   */
  create(request: CreateAgentRoleRequest): AgentRole {
    const now = Date.now();
    const role: AgentRole = {
      id: uuidv4(),
      name: request.name,
      displayName: request.displayName,
      description: request.description,
      icon: request.icon || '🤖',
      color: request.color || '#6366f1',
      personalityId: request.personalityId,
      modelKey: request.modelKey,
      providerType: request.providerType,
      systemPrompt: request.systemPrompt,
      capabilities: request.capabilities,
      toolRestrictions: request.toolRestrictions,
      isSystem: false,
      isActive: true,
      sortOrder: 100,
      createdAt: now,
      updatedAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO agent_roles (
        id, name, display_name, description, icon, color,
        personality_id, model_key, provider_type, system_prompt,
        capabilities, tool_restrictions, is_system, is_active,
        sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      role.id,
      role.name,
      role.displayName,
      role.description || null,
      role.icon,
      role.color,
      role.personalityId || null,
      role.modelKey || null,
      role.providerType || null,
      role.systemPrompt || null,
      JSON.stringify(role.capabilities),
      role.toolRestrictions ? JSON.stringify(role.toolRestrictions) : null,
      role.isSystem ? 1 : 0,
      role.isActive ? 1 : 0,
      role.sortOrder,
      role.createdAt,
      role.updatedAt
    );

    return role;
  }

  /**
   * Find an agent role by ID
   */
  findById(id: string): AgentRole | undefined {
    const stmt = this.db.prepare('SELECT * FROM agent_roles WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.mapRowToAgentRole(row) : undefined;
  }

  /**
   * Find an agent role by name
   */
  findByName(name: string): AgentRole | undefined {
    const stmt = this.db.prepare('SELECT * FROM agent_roles WHERE name = ?');
    const row = stmt.get(name) as any;
    return row ? this.mapRowToAgentRole(row) : undefined;
  }

  /**
   * Find all agent roles
   */
  findAll(includeInactive = false): AgentRole[] {
    const stmt = includeInactive
      ? this.db.prepare('SELECT * FROM agent_roles ORDER BY sort_order ASC, created_at ASC')
      : this.db.prepare('SELECT * FROM agent_roles WHERE is_active = 1 ORDER BY sort_order ASC, created_at ASC');
    const rows = stmt.all() as any[];
    return rows.map(row => this.mapRowToAgentRole(row));
  }

  /**
   * Find all active agent roles
   */
  findActive(): AgentRole[] {
    return this.findAll(false);
  }

  /**
   * Update an agent role
   */
  update(request: UpdateAgentRoleRequest): AgentRole | undefined {
    const existing = this.findById(request.id);
    if (!existing) {
      return undefined;
    }

    // Don't allow updating system roles' core properties
    if (existing.isSystem && (request.capabilities || request.toolRestrictions)) {
      console.warn('Cannot modify capabilities or tool restrictions of system agent roles');
    }

    const fields: string[] = [];
    const values: any[] = [];

    if (request.displayName !== undefined) {
      fields.push('display_name = ?');
      values.push(request.displayName);
    }
    if (request.description !== undefined) {
      fields.push('description = ?');
      values.push(request.description);
    }
    if (request.icon !== undefined) {
      fields.push('icon = ?');
      values.push(request.icon);
    }
    if (request.color !== undefined) {
      fields.push('color = ?');
      values.push(request.color);
    }
    if (request.personalityId !== undefined) {
      fields.push('personality_id = ?');
      values.push(request.personalityId);
    }
    if (request.modelKey !== undefined) {
      fields.push('model_key = ?');
      values.push(request.modelKey);
    }
    if (request.providerType !== undefined) {
      fields.push('provider_type = ?');
      values.push(request.providerType);
    }
    if (request.systemPrompt !== undefined) {
      fields.push('system_prompt = ?');
      values.push(request.systemPrompt);
    }
    if (request.capabilities !== undefined && !existing.isSystem) {
      fields.push('capabilities = ?');
      values.push(JSON.stringify(request.capabilities));
    }
    if (request.toolRestrictions !== undefined && !existing.isSystem) {
      fields.push('tool_restrictions = ?');
      values.push(request.toolRestrictions ? JSON.stringify(request.toolRestrictions) : null);
    }
    if (request.isActive !== undefined) {
      fields.push('is_active = ?');
      values.push(request.isActive ? 1 : 0);
    }
    if (request.sortOrder !== undefined) {
      fields.push('sort_order = ?');
      values.push(request.sortOrder);
    }

    if (fields.length === 0) {
      return existing;
    }

    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(request.id);

    const sql = `UPDATE agent_roles SET ${fields.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...values);

    return this.findById(request.id);
  }

  /**
   * Delete an agent role (only non-system roles)
   */
  delete(id: string): boolean {
    const existing = this.findById(id);
    if (!existing) {
      return false;
    }
    if (existing.isSystem) {
      console.warn('Cannot delete system agent roles');
      return false;
    }

    const stmt = this.db.prepare('DELETE FROM agent_roles WHERE id = ? AND is_system = 0');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Seed default agent roles if none exist
   */
  seedDefaults(): AgentRole[] {
    const existing = this.findAll(true);
    if (existing.length > 0) {
      return existing;
    }

    const seeded: AgentRole[] = [];
    const now = Date.now();

    for (const defaultRole of DEFAULT_AGENT_ROLES) {
      const role: AgentRole = {
        id: uuidv4(),
        ...defaultRole,
        createdAt: now,
        updatedAt: now,
      };

      const stmt = this.db.prepare(`
        INSERT INTO agent_roles (
          id, name, display_name, description, icon, color,
          personality_id, model_key, provider_type, system_prompt,
          capabilities, tool_restrictions, is_system, is_active,
          sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        role.id,
        role.name,
        role.displayName,
        role.description || null,
        role.icon,
        role.color,
        role.personalityId || null,
        role.modelKey || null,
        role.providerType || null,
        role.systemPrompt || null,
        JSON.stringify(role.capabilities),
        role.toolRestrictions ? JSON.stringify(role.toolRestrictions) : null,
        role.isSystem ? 1 : 0,
        role.isActive ? 1 : 0,
        role.sortOrder,
        role.createdAt,
        role.updatedAt
      );

      seeded.push(role);
    }

    return seeded;
  }

  /**
   * Check if any agent roles exist
   */
  hasAny(): boolean {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM agent_roles');
    const result = stmt.get() as { count: number };
    return result.count > 0;
  }

  /**
   * Map database row to AgentRole object
   */
  private mapRowToAgentRole(row: any): AgentRole {
    return {
      id: row.id,
      name: row.name,
      displayName: row.display_name,
      description: row.description || undefined,
      icon: row.icon || '🤖',
      color: row.color || '#6366f1',
      personalityId: row.personality_id || undefined,
      modelKey: row.model_key || undefined,
      providerType: row.provider_type || undefined,
      systemPrompt: row.system_prompt || undefined,
      capabilities: safeJsonParse<AgentCapability[]>(row.capabilities, [], 'agentRole.capabilities'),
      toolRestrictions: safeJsonParse<AgentToolRestrictions | undefined>(row.tool_restrictions, undefined, 'agentRole.toolRestrictions'),
      isSystem: row.is_system === 1,
      isActive: row.is_active === 1,
      sortOrder: row.sort_order || 100,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
