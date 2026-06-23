import { type RagExplorerState, type QueryOptions, type GraphWorkspaceState, DEFAULT_RAG_EXPLORER_STATE, type QueryResponse } from "../types";

export type RagExplorerListener = (state: RagExplorerState) => void;

export class RagExplorerStore {
  private state: RagExplorerState;
  private listeners: Set<RagExplorerListener> = new Set();

  constructor(initialState: Partial<RagExplorerState> = {}) {
    this.state = { ...DEFAULT_RAG_EXPLORER_STATE, ...initialState };
  }

  getState(): RagExplorerState {
    return this.state;
  }

  subscribe(listener: RagExplorerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setState(patch: Partial<RagExplorerState>): void {
    this.state = { ...this.state, ...patch };
    this.notify();
  }

  resetWorkspace(): void {
    this.setState({
      workspace: { nodes: [], edges: [], positions: [] },
      selectedNodeId: null,
      queryResponse: null,
    });
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}
