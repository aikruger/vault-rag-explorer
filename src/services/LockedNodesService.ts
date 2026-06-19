const LOG_PREFIX = "[LockedNodesService]";

export interface LockedNode {
  nodeType: 'note' | 'block';
  nodeId: number;
  path: string;
  title: string;
  blockKey?: string;
  lockedAt: number;
}

export class LockedNodesService {
  private lockedNodes: Map<string, LockedNode> = new Map();

  lock(node: LockedNode): void {
    const key = `${node.nodeType}-${node.nodeId}`;
    this.lockedNodes.set(key, node);
    console.log(`${LOG_PREFIX} Locked node key=${key} path=${node.path}`);
  }

  unlock(key: string): void {
    if (this.lockedNodes.has(key)) {
      this.lockedNodes.delete(key);
      console.log(`${LOG_PREFIX} Unlocked node key=${key}`);
    }
  }

  isLocked(key: string): boolean {
    return this.lockedNodes.has(key);
  }

  getAll(): LockedNode[] {
    return Array.from(this.lockedNodes.values());
  }

  clear(): void {
    this.lockedNodes.clear();
    console.log(`${LOG_PREFIX} Cleared all locked nodes`);
  }
}
