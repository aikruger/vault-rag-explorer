/* eslint-disable obsidianmd/rule-custom-message, obsidianmd/no-static-styles-assignment, obsidianmd/prefer-active-doc, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import * as d3 from "d3";
import type { RetrievalHit } from "../types";
import type { LockedNode } from "../services/LockedNodesService";

export interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
  nodeType: "block" | "note" | "query";
  score: number;
  sourceId: number;
  locked: boolean;
  excluded: boolean;
  radius: number;
  expansionSource?: boolean;
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface GraphEdge extends d3.SimulationLinkDatum<GraphNode> {
  id: string;
  source: string | GraphNode;
  target: string | GraphNode;
  edgeType: "semantic" | "wikilink";
  weight: number;
  expansion: boolean;
}

export class D3GraphPanel {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private simulation: d3.Simulation<GraphNode, GraphEdge>;
  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];
  private transform: d3.ZoomTransform = d3.zoomIdentity;
  private hoveredNode: GraphNode | null = null;
  private selectedNodeId: string | null = null;
  private onNodeClick: ((nodeId: string) => void) | null = null;
  private width: number = 0;
  private height: number = 0;
  private animationFrameId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private nodeSizeScale: number = 1.0;

  constructor(container: HTMLElement) {
    this.container = container;
    console.log("[D3GraphPanel] constructor — creating canvas");
    this.canvas = document.createElement("canvas");
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.display = "block";
    container.appendChild(this.canvas);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("[D3GraphPanel] Could not get 2D canvas context");
    this.ctx = ctx;
    this.simulation = this.createSimulation();
    this.attachZoomAndPan();
    this.attachMouseEvents();
    this.observeResize();
    this.updateSize();
    console.log("[D3GraphPanel] constructor complete");
  }

  private createSimulation(): d3.Simulation<GraphNode, GraphEdge> {
    const sim = d3.forceSimulation<GraphNode, GraphEdge>()
      .force("charge", d3.forceManyBody().strength(-120))
      .force("center", d3.forceCenter(this.width / 2, this.height / 2))
      .force("collision", d3.forceCollide<GraphNode>().radius(d => d.radius + 4))
      .force("link", d3.forceLink<GraphNode, GraphEdge>()
        .id(d => d.id)
        .distance(d => {
          const w = typeof d.weight === "number" ? d.weight : 0.5;
          return 40 + (1 - w) * 260;
        })
        .strength(0.4)
      )
      .on("tick", () => this.drawFrame());

    console.log("[D3GraphPanel] simulation created");
    return sim;
  }

  private computeRadii(): void {
    const degree = new Map<string, number>();
    for (const node of this.nodes) degree.set(node.id, 0);
    for (const edge of this.edges) {
      const srcId = typeof edge.source === "string" ? edge.source : (edge.source).id;
      const tgtId = typeof edge.target === "string" ? edge.target : (edge.target).id;
      degree.set(srcId, (degree.get(srcId) ?? 0) + 1);
      degree.set(tgtId, (degree.get(tgtId) ?? 0) + 1);
    }
    const maxDegree = Math.max(1, ...degree.values());
    for (const node of this.nodes) {
      const d = degree.get(node.id) ?? 0;
      const base = node.nodeType === "block" ? 5 : 7;
      const max = node.nodeType === "block" ? 20 : 28;
      node.radius = (base + (d / maxDegree) * (max - base)) * this.nodeSizeScale;
    }
    console.log("[D3GraphPanel] computeRadii complete, maxDegree=", maxDegree);
  }

  private drawFrame(): void {
    const { width, height, ctx, transform } = this;
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    for (const edge of this.edges) {
      const src = edge.source as GraphNode;
      const tgt = edge.target as GraphNode;
      if (src.x === undefined || tgt.x === undefined) continue;
      if (src.excluded || tgt.excluded) continue;

      ctx.beginPath();
      ctx.moveTo(src.x, src.y!);
      ctx.lineTo(tgt.x, tgt.y!);

      if (edge.expansion) {
        ctx.strokeStyle = edge.edgeType === "wikilink" ? "#ffd700" : "#4a9eff";
        ctx.lineWidth = 3;
        ctx.setLineDash([]);
      } else if (edge.edgeType === "wikilink") {
        ctx.strokeStyle = "#ffd700";
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.7;
        ctx.setLineDash([]);
      } else {
        const w = typeof edge.weight === "number" ? edge.weight : 0.5;
        ctx.strokeStyle = "#4a9eff";
        ctx.lineWidth = 0.5 + w * 2.5;
        ctx.globalAlpha = 0.3 + w * 0.4;
        ctx.setLineDash([4, 4]);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    }

    for (const node of this.nodes) {
      if (node.excluded) continue;
      if (node.x === undefined) continue;

      const isHovered = this.hoveredNode?.id === node.id;
      const isSelected = this.selectedNodeId === node.id;

      let fill = "#4a9eff";
      if (node.nodeType === "block") fill = "#7b6af5";
      if (node.nodeType === "query") fill = "#ffffff";

      ctx.beginPath();
      ctx.arc(node.x, node.y!, node.radius, 0, 2 * Math.PI);
      ctx.fillStyle = fill;
      ctx.fill();

      if (node.locked) {
        ctx.strokeStyle = "#ffd700";
        ctx.lineWidth = 3;
      } else if (isSelected) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2.5;
      } else if (isHovered) {
        ctx.strokeStyle = "rgba(255,255,255,0.6)";
        ctx.lineWidth = 1.5;
      } else {
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.lineWidth = 1;
      }
      ctx.stroke();

      if (isHovered || isSelected || node.radius > 12) {
        ctx.font = `${isSelected ? "bold " : ""}10px sans-serif`;
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.shadowColor = "#000000";
        ctx.shadowBlur = 3;
        const shortLabel = node.label.length > 22 ? node.label.slice(0, 20) + "…" : node.label;
        ctx.fillText(shortLabel, node.x, node.y! + node.radius + 3);
        ctx.shadowBlur = 0;
      }
    }

    ctx.restore();
  }

  private attachZoomAndPan(): void {
    const zoom = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.1, 8])
      .on("zoom", (event) => {
        this.transform = event.transform;
        this.drawFrame();
      });

    d3.select(this.canvas).call(zoom);
    console.log("[D3GraphPanel] zoom and pan attached");
  }

  private attachMouseEvents(): void {
    const canvas = this.canvas;
    let dragging: GraphNode | null = null;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    const toSimCoords = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const x = (clientX - rect.left - this.transform.x) / this.transform.k;
      const y = (clientY - rect.top - this.transform.y) / this.transform.k;
      return { x, y };
    };

    const findNode = (x: number, y: number): GraphNode | null => {
      for (let i = this.nodes.length - 1; i >= 0; i--) {
        const n = this.nodes[i]!;
        if (n.excluded || !n.x) continue;
        const dx = n.x - x;
        const dy = (n.y ?? 0) - y;
        if (Math.sqrt(dx * dx + dy * dy) <= n.radius + 3) return n;
      }
      return null;
    };

    canvas.addEventListener("mousemove", (e) => {
      const { x, y } = toSimCoords(e.clientX, e.clientY);
      if (dragging) {
        dragging.fx = x - dragOffsetX;
        dragging.fy = y - dragOffsetY;
        this.simulation.alpha(0.3).restart();
        return;
      }
      const hit = findNode(x, y);
      if (hit !== this.hoveredNode) {
        this.hoveredNode = hit;
        canvas.style.cursor = hit ? "grab" : "default";
        this.drawFrame();
      }
    });

    canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const { x, y } = toSimCoords(e.clientX, e.clientY);
      const hit = findNode(x, y);
      if (hit) {
        dragging = hit;
        dragOffsetX = x - (hit.x ?? 0);
        dragOffsetY = y - (hit.y ?? 0);
        hit.fx = hit.x ?? 0;
        hit.fy = hit.y ?? 0;
        canvas.style.cursor = "grabbing";
        console.log(`[D3GraphPanel] drag start node=${hit.id}`);
      }
    });

    canvas.addEventListener("mouseup", (e) => {
      if (dragging) {
        console.log(`[D3GraphPanel] drag end node=${dragging.id}, releasing pin`);
        dragging.fx = null;
        dragging.fy = null;
        this.simulation.alpha(0.4).restart();
        dragging = null;
        canvas.style.cursor = this.hoveredNode ? "grab" : "default";
      }
    });

    canvas.addEventListener("click", (e) => {
      const { x, y } = toSimCoords(e.clientX, e.clientY);
      const hit = findNode(x, y);
      if (hit) {
        this.selectedNodeId = hit.id;
        console.log(`[D3GraphPanel] node clicked id=${hit.id}`);
        this.onNodeClick?.(hit.id);
        this.drawFrame();
      }
    });

    canvas.addEventListener("dblclick", (e) => {
      const { x, y } = toSimCoords(e.clientX, e.clientY);
      const hit = findNode(x, y);
      if (hit) {
        hit.fx = null;
        hit.fy = null;
        this.simulation.alpha(0.3).restart();
        console.log(`[D3GraphPanel] double-click unpinned node=${hit.id}`);
      }
    });

    console.log("[D3GraphPanel] mouse events attached");
  }

  private observeResize(): void {
    this.resizeObserver = new ResizeObserver(() => {
      this.updateSize();
      this.simulation.force("center", d3.forceCenter(this.width / 2, this.height / 2));
      this.simulation.alpha(0.2).restart();
    });
    this.resizeObserver.observe(this.container);
    console.log("[D3GraphPanel] resize observer attached");
  }

  private updateSize(): void {
    const rect = this.container.getBoundingClientRect();
    this.width = rect.width || 600;
    this.height = rect.height || 400;
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    console.log(`[D3GraphPanel] size updated width=${this.width} height=${this.height}`);
  }

  setGraph(nodes: GraphNode[], edges: GraphEdge[]): void {
    console.log(`[D3GraphPanel] setGraph nodes=${nodes.length} edges=${edges.length}`);
    const posMap = new Map<string, { x: number; y: number; fx: number | null | undefined; fy: number | null | undefined }>();
    for (const n of this.nodes) {
      if (n.x !== undefined) posMap.set(n.id, { x: n.x, y: n.y ?? 0, fx: n.fx, fy: n.fy });
    }
    this.nodes = nodes;
    this.edges = edges;
    for (const n of this.nodes) {
      const prev = posMap.get(n.id);
      if (prev) { n.x = prev.x; n.y = prev.y; n.fx = prev.fx; n.fy = prev.fy; }
      else { n.x = this.width / 2 + (Math.random() - 0.5) * 200; n.y = this.height / 2 + (Math.random() - 0.5) * 200; }
    }
    this.computeRadii();
    this.simulation.nodes(this.nodes);
    (this.simulation.force("link") as d3.ForceLink<GraphNode, GraphEdge>).links(this.edges);
    this.simulation.alpha(0.8).restart();
    console.log("[D3GraphPanel] simulation restarted after setGraph");
  }

  addNodes(newNodes: GraphNode[], newEdges: GraphEdge[]): void {
    console.log(`[D3GraphPanel] addNodes new=${newNodes.length} newEdges=${newEdges.length}`);
    const existingIds = new Set(this.nodes.map(n => n.id));
    for (const n of newNodes) {
      if (!existingIds.has(n.id)) {
        n.x = this.width / 2 + (Math.random() - 0.5) * 100;
        n.y = this.height / 2 + (Math.random() - 0.5) * 100;
        this.nodes.push(n);
      }
    }
    const existingEdgeIds = new Set(this.edges.map(e => e.id));
    for (const e of newEdges) {
      if (!existingEdgeIds.has(e.id)) this.edges.push(e);
    }
    this.computeRadii();
    this.simulation.nodes(this.nodes);
    (this.simulation.force("link") as d3.ForceLink<GraphNode, GraphEdge>).links(this.edges);
    this.simulation.alpha(0.5).restart();
    console.log("[D3GraphPanel] simulation restarted after addNodes");
  }

  removeNode(nodeId: string): void {
    console.log(`[D3GraphPanel] removeNode id=${nodeId}`);
    this.nodes = this.nodes.filter(n => n.id !== nodeId);
    this.edges = this.edges.filter(e => {
      const srcId = typeof e.source === "string" ? e.source : (e.source).id;
      const tgtId = typeof e.target === "string" ? e.target : (e.target).id;
      return srcId !== nodeId && tgtId !== nodeId;
    });
    this.computeRadii();
    this.simulation.nodes(this.nodes);
    (this.simulation.force("link") as d3.ForceLink<GraphNode, GraphEdge>).links(this.edges);
    this.simulation.alpha(0.3).restart();
  }

  excludeBySourceId(sourceId: number): void {
    console.log(`[D3GraphPanel] excludeBySourceId sourceId=${sourceId}`);
    let count = 0;
    for (const n of this.nodes) {
      if (n.sourceId === sourceId) { n.excluded = true; count++; }
    }
    console.log(`[D3GraphPanel] excluded ${count} nodes for sourceId=${sourceId}`);
    this.drawFrame();
  }

  restoreBySourceId(sourceId: number): void {
    console.log(`[D3GraphPanel] restoreBySourceId sourceId=${sourceId}`);
    let count = 0;
    for (const n of this.nodes) {
      if (n.sourceId === sourceId) { n.excluded = false; count++; }
    }
    console.log(`[D3GraphPanel] restored ${count} nodes for sourceId=${sourceId}`);
    this.drawFrame();
  }

  setNodeLocked(nodeId: string, locked: boolean): void {
    const node = this.nodes.find(n => n.id === nodeId);
    if (node) { node.locked = locked; this.drawFrame(); }
    console.log(`[D3GraphPanel] setNodeLocked id=${nodeId} locked=${locked}`);
  }

  selectNode(nodeId: string | null): void {
    this.selectedNodeId = nodeId;
    this.drawFrame();
    console.log(`[D3GraphPanel] selectNode id=${nodeId}`);
  }

  getPositions(): Record<string, { x: number; y: number }> {
    const out: Record<string, { x: number; y: number }> = {};
    for (const n of this.nodes) {
      if (n.x !== undefined) out[n.id] = { x: n.x, y: n.y ?? 0 };
    }
    return out;
  }

  restorePositions(positions: Record<string, { x: number; y: number }>): void {
    console.log(`[D3GraphPanel] restorePositions count=${Object.keys(positions).length}`);
    for (const n of this.nodes) {
      const pos = positions[n.id];
      if (pos) { n.x = pos.x; n.y = pos.y; n.fx = pos.x; n.fy = pos.y; }
    }
    this.drawFrame();
  }

  setOnNodeClick(cb: (nodeId: string) => void): void {
    this.onNodeClick = cb;
  }

  destroy(): void {
    console.log("[D3GraphPanel] destroy called");
    this.simulation.stop();
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    this.resizeObserver?.disconnect();
    this.canvas.remove();
  }
  setSimulationParams(params: {
    linkDistance?: number;
    chargeStrength?: number;
    nodeSizeScale?: number;
  }): void {
    console.log("[D3GraphPanel] setSimulationParams", params);

    if (params.linkDistance !== undefined) {
      (this.simulation.force("link") as d3.ForceLink<GraphNode, GraphEdge>)
        .distance(d => {
          const w = typeof d.weight === "number" ? d.weight : 0.5;
          return params.linkDistance! + (1 - w) * 80;
        });
    }
    if (params.chargeStrength !== undefined) {
      (this.simulation.force("charge") as d3.ForceManyBody<GraphNode>)
        .strength(params.chargeStrength);
    }
    if (params.nodeSizeScale !== undefined) {
      this.nodeSizeScale = params.nodeSizeScale;
      this.computeRadii();
    }
    this.simulation.alpha(0.4).restart();
  }

}
