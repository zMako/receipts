/**
 * The three.js evidence graph: a 3d-force-graph rendered as a restrained, matte, light-theme scene.
 * Pure presentation: reads State, reacts to LiveEvents. No bloom, particles or avatars; evidence
 * attaches scale the touched nodes briefly, tint their edges with the agent's colour, then settle
 * into a persistent outline plus a CSS2D label.
 */
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph'
import * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { AGENT_META, type LiveEvent } from './contract'
import type { GNode, NodeType, State } from './state'
import { ACCENT, AGENT_COLOR, UI, populationOf } from './theme'

export interface FNode extends GNode {
  x?: number
  y?: number
  z?: number
  vx?: number
  vy?: number
  vz?: number
  fx?: number
  fy?: number
  fz?: number
}

export interface FLink {
  key: string
  source: string | FNode
  target: string | FNode
  type: string
  delta?: boolean
}

interface NodeVisual {
  group: THREE.Group
  core: THREE.Mesh
  mat: THREE.MeshStandardMaterial
  outline: THREE.Mesh
  outlineMat: THREE.MeshBasicMaterial
  radius: number
  label: CSS2DObject | null
}

/** Highlight timeline for a node: scale-up over 400ms, hold, settle into the persistent outline. */
interface Mark {
  t0: number
  color: string
  /** Label text override; the node's short label when undefined. */
  text?: string
}

interface LinkFx {
  mat: THREE.LineBasicMaterial
  t0: number
}

const CARD_BG = 0xffffff
const ATTACK_S = 0.4
const HOLD_S = 3.0
const SETTLE_S = 0.4
const PEAK_SCALE = 1.6
const REST_SCALE = 1.12
const EDGE_HOT = 0.9
const EDGE_REST = 0.5
const MAX_LABELS = 28
/** OrbitControls: 2.0 is one revolution per 30s at 60fps; we want one per three minutes. */
const ORBIT_SPEED = 2.0 * (30 / 180)
const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const NEUTRAL: Record<NodeType, string> = {
  customer: UI.neutralNode,
  order: ACCENT.human,
  device: '#B9C2CF',
  address: '#B9C2CF',
  payment: '#B9C2CF',
  return: '#94A3B8',
  dispute: ACCENT.flagged,
  evidence: '#94A3B8',
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function idOf(end: string | FNode | undefined): string {
  return typeof end === 'object' && end ? end.id : String(end ?? '')
}

const easeOut = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3)

function darker(hex: string, k = 0.72): THREE.Color {
  return new THREE.Color(hex).multiplyScalar(k)
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function shortLabel(n: FNode): string {
  const raw = n.type === 'customer' ? n.label : n.label || n.id
  return raw.length > 26 ? `${raw.slice(0, 25)}…` : raw
}

export class ExhibitScene {
  readonly graph: ForceGraph3DInstance<FNode, FLink>
  private readonly container: HTMLElement
  private readonly fgNodes = new Map<string, FNode>()
  private readonly fgLinks = new Map<string, FLink>()
  private readonly visuals = new Map<string, NodeVisual>()
  private readonly marks = new Map<string, Mark>()
  private readonly linkFx = new Map<string, LinkFx>()
  private readonly geo: Record<string, THREE.BufferGeometry>
  private readonly defaultLinkMat: THREE.LineBasicMaterial
  private readonly fog: THREE.Fog
  private readonly css2d: CSS2DRenderer | null
  private caseOrderId: string | null = null
  private pendingFocus: string | null = null
  private settled = false
  private t = 0
  private resumeOrbitAt: number | null = null
  private dragging = false
  private controls: OrbitControls | null = null
  private resizeObserver: ResizeObserver | null = null
  private disposed = false
  private labelCount = 0
  private readonly onWindowResize = () => this.resize()

  constructor(container: HTMLElement) {
    this.container = container
    this.geo = {
      sphere: new THREE.SphereGeometry(1, 28, 20),
      device: new THREE.SphereGeometry(1, 16, 12),
      address: new THREE.CylinderGeometry(1, 1, 0.28, 24),
      payment: new THREE.BoxGeometry(1.5, 1.5, 1.5),
      return: new THREE.TorusGeometry(1, 0.26, 10, 28),
      ring: new THREE.TorusGeometry(1, 0.045, 8, 48),
      outline: new THREE.SphereGeometry(1, 28, 20),
    }
    this.defaultLinkMat = new THREE.LineBasicMaterial({ color: UI.edge, transparent: true, opacity: 0.35, depthWrite: false })
    this.fog = new THREE.Fog(CARD_BG, 300, 1100)

    let css2d: CSS2DRenderer | null = null
    try {
      css2d = new CSS2DRenderer()
      css2d.domElement.style.overflow = 'hidden'
    } catch (err) {
      console.warn('[scene] CSS2D labels unavailable', err)
    }
    this.css2d = css2d

    const w = Math.max(1, container.clientWidth || 800)
    const h = Math.max(1, container.clientHeight || 600)
    const graph = new ForceGraph3D(container, {
      controlType: 'orbit',
      rendererConfig: { antialias: true, alpha: true, powerPreference: 'high-performance' },
      extraRenderers: css2d ? [css2d] : [],
    }) as unknown as ForceGraph3DInstance<FNode, FLink>
    this.graph = graph
    graph
      .width(w)
      .height(h)
      .backgroundColor('rgba(0,0,0,0)')
      .showNavInfo(false)
      .nodeId('id')
      .nodeLabel((n) => this.tooltip(n))
      .nodeThreeObject((n) => this.buildNode(n))
      .nodeThreeObjectExtend(false)
      .linkSource('source')
      .linkTarget('target')
      .linkWidth(0)
      .linkOpacity(0.35)
      .linkMaterial((l) => this.linkMaterialOf(l))
      .enableNodeDrag(false)
      .onNodeClick((n) => n && this.focusNeighbourhood(n.id))
      .d3AlphaDecay(0.028)
      .d3VelocityDecay(0.42)
      .warmupTicks(240)
      .cooldownTicks(0)
      .onEngineStop(() => this.onSettled())

    const charge = graph.d3Force('charge')
    if (charge && typeof charge.strength === 'function') charge.strength(-46)
    const link = graph.d3Force('link')
    if (link && typeof link.distance === 'function') link.distance((l: FLink) => (l.type === 'placed' ? 26 : 18))

    const key = new THREE.DirectionalLight(0xffffff, 1.7)
    key.position.set(1, 1.6, 1.2)
    const fill = new THREE.DirectionalLight(0xffffff, 0.45)
    fill.position.set(-1, -0.4, -1)
    graph.lights([new THREE.HemisphereLight(0xffffff, 0xdfe5ee, 2.1), key, fill])

    const scene = graph.scene()
    scene.fog = this.fog

    try {
      const renderer = graph.renderer()
      renderer.toneMapping = THREE.NoToneMapping
      renderer.setClearColor(0x000000, 0)
    } catch {
      /* renderer config is cosmetic */
    }

    const controls = graph.controls() as OrbitControls
    this.controls = controls
    if (controls) {
      controls.enableDamping = true
      controls.dampingFactor = 0.08
      controls.autoRotate = !REDUCED_MOTION
      controls.autoRotateSpeed = ORBIT_SPEED
      controls.maxDistance = 1400
      controls.minDistance = 30
      controls.addEventListener('start', () => {
        this.dragging = true
        controls.autoRotate = false
        this.resumeOrbitAt = null
      })
      controls.addEventListener('end', () => {
        this.dragging = false
        this.resumeOrbitAt = this.t + 6
      })
    }

    graph.cameraPosition({ x: 0, y: 70, z: 440 }, { x: 0, y: 0, z: 0 }, 0)

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize())
      this.resizeObserver.observe(container)
    }
    window.addEventListener('resize', this.onWindowResize)
  }

  // ----- graph data ---------------------------------------------------------------------------

  /** Sync force-graph node/link objects with the reducer's graph. Objects are kept stable so layout survives. */
  setGraph(state: State): void {
    if (this.disposed) return
    const g = state.graph
    const first = this.fgNodes.size === 0 && g.nodes.length > 0
    let changed = false
    const seen = new Set<string>()
    const added: FNode[] = []
    for (const n of g.nodes) {
      seen.add(n.id)
      const existing = this.fgNodes.get(n.id)
      if (!existing) {
        const fn: FNode = { ...n }
        this.fgNodes.set(n.id, fn)
        added.push(fn)
        changed = true
      } else if (existing.population !== n.population || existing.label !== n.label || (existing.flags?.length ?? 0) !== (n.flags?.length ?? 0)) {
        existing.population = n.population
        existing.label = n.label
        existing.flags = n.flags
        this.restyle(existing)
      }
    }
    for (const id of [...this.fgNodes.keys()]) {
      if (!seen.has(id)) {
        this.fgNodes.delete(id)
        this.dropVisual(id)
        this.marks.delete(id)
        changed = true
      }
    }
    const linkSeen = new Set<string>()
    for (const e of g.edges) {
      const key = `${e.source}>${e.target}:${e.type}`
      linkSeen.add(key)
      if (!this.fgLinks.has(key)) {
        this.fgLinks.set(key, { key, source: e.source, target: e.target, type: e.type, delta: e.delta })
        changed = true
      }
    }
    for (const key of [...this.fgLinks.keys()]) {
      if (!linkSeen.has(key)) {
        this.fgLinks.delete(key)
        const fx = this.linkFx.get(key)
        if (fx) {
          fx.mat.dispose()
          this.linkFx.delete(key)
        }
        changed = true
      }
    }
    if (!changed) return

    if (first) {
      // Seeded initial positions: the warm-up then runs synchronously so the first frame is settled.
      for (const n of this.fgNodes.values()) {
        const r = rng(hash(n.id))
        const radius = 60 + r() * 120
        const theta = r() * Math.PI * 2
        const phi = Math.acos(2 * r() - 1)
        n.x = radius * Math.sin(phi) * Math.cos(theta)
        n.y = radius * Math.sin(phi) * Math.sin(theta) * 0.8
        n.z = radius * Math.cos(phi)
      }
      this.graph.warmupTicks(240).cooldownTicks(0)
    } else {
      // Place newcomers next to a neighbour so they do not fly in from the origin, then let only them settle.
      for (const n of added) {
        const r = rng(hash(n.id))
        const nb: FNode[] = []
        for (const l of this.fgLinks.values()) {
          const s = idOf(l.source)
          const t = idOf(l.target)
          if (s === n.id) {
            const o = this.fgNodes.get(t)
            if (o && o.x !== undefined) nb.push(o)
          } else if (t === n.id) {
            const o = this.fgNodes.get(s)
            if (o && o.x !== undefined) nb.push(o)
          }
        }
        const c = nb.length ? nb.reduce((a, o) => a.add(new THREE.Vector3(o.x, o.y, o.z)), new THREE.Vector3()).multiplyScalar(1 / nb.length) : new THREE.Vector3(0, 40, 0)
        n.x = c.x + (r() - 0.5) * 24
        n.y = c.y + (r() - 0.5) * 24 + 6
        n.z = c.z + (r() - 0.5) * 24
      }
      this.graph.warmupTicks(0).cooldownTicks(this.settled ? 160 : 0)
    }
    try {
      this.graph.graphData({ nodes: [...this.fgNodes.values()], links: [...this.fgLinks.values()] })
    } catch (err) {
      console.warn('[scene] graphData failed', err)
    }
  }

  private onSettled() {
    for (const n of this.fgNodes.values()) {
      n.fx = n.x
      n.fy = n.y
      n.fz = n.z
    }
    if (!this.settled) {
      this.settled = true
      // First paint: frame the whole merchant, unless a case already asked for its neighbourhood.
      if (this.caseOrderId) this.focusNeighbourhood(this.caseOrderId)
      else {
        try {
          // Instant: nothing is on screen yet, so an animated fit would only delay first paint.
          this.graph.zoomToFit(0, 60)
        } catch {
          /* no nodes yet */
        }
      }
    }
  }

  // ----- node visuals -------------------------------------------------------------------------

  private styleOf(n: FNode): { color: string; geo: THREE.BufferGeometry; radius: number; ring: boolean } {
    if (n.type === 'device' && n.population === 'cluster') return { color: ACCENT.cluster, geo: this.geo.device, radius: 1.9, ring: true }
    if (n.type === 'order') {
      const amount = Number(n.amount) || 120
      const radius = Math.max(1.8, Math.min(4.4, 1.3 + 0.12 * Math.sqrt(amount)))
      return { color: n.population ? populationOf(n.population).color : NEUTRAL.order, geo: this.geo.sphere, radius, ring: false }
    }
    if (n.type === 'customer') return { color: NEUTRAL.customer, geo: this.geo.sphere, radius: 3.3, ring: false }
    if (n.type === 'device') return { color: NEUTRAL.device, geo: this.geo.device, radius: 1.3, ring: false }
    if (n.type === 'address') return { color: NEUTRAL.address, geo: this.geo.address, radius: 1.7, ring: false }
    if (n.type === 'payment') return { color: NEUTRAL.payment, geo: this.geo.payment, radius: 1.2, ring: false }
    if (n.type === 'return') return { color: NEUTRAL.return, geo: this.geo.return, radius: 1.7, ring: false }
    if (n.type === 'dispute') return { color: NEUTRAL.dispute, geo: this.geo.sphere, radius: 1.7, ring: false }
    return { color: NEUTRAL.evidence, geo: this.geo.device, radius: 1.4, ring: false }
  }

  private buildNode(n: FNode): THREE.Object3D {
    const st = this.styleOf(n)
    const mat = new THREE.MeshStandardMaterial({ color: st.color, roughness: 0.9, metalness: 0 })
    const core = new THREE.Mesh(st.geo, mat)
    core.scale.setScalar(st.radius)
    if (n.type === 'address') core.rotation.x = Math.PI / 2
    if (n.type === 'return') core.rotation.x = Math.PI / 3
    const outlineMat = new THREE.MeshBasicMaterial({ color: darker(st.color), side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false })
    const outline = new THREE.Mesh(this.geo.outline, outlineMat)
    outline.scale.setScalar(st.radius * 1.22)
    outline.visible = false
    const group = new THREE.Group()
    group.add(core, outline)
    if (st.ring) {
      const ring = new THREE.Mesh(this.geo.ring, new THREE.MeshBasicMaterial({ color: ACCENT.cluster, transparent: true, opacity: 0.85, depthWrite: false }))
      ring.scale.setScalar(st.radius * 2.1)
      ring.rotation.x = Math.PI / 2.6
      ring.rotation.y = (hash(n.id) % 100) / 100
      group.add(ring)
    }
    this.dropVisual(n.id)
    this.visuals.set(n.id, { group, core, mat, outline, outlineMat, radius: st.radius, label: null })
    return group
  }

  private restyle(n: FNode) {
    const v = this.visuals.get(n.id)
    if (!v) return
    const st = this.styleOf(n)
    v.mat.color.set(st.color)
    v.outlineMat.color.copy(darker(st.color))
    v.radius = st.radius
    v.core.scale.setScalar(st.radius)
    v.outline.scale.setScalar(st.radius * 1.22)
    if (v.core.geometry !== st.geo) v.core.geometry = st.geo
    if (v.label) this.setLabel(n.id, this.marks.get(n.id)?.color ?? UI.muted)
  }

  private dropVisual(id: string) {
    const v = this.visuals.get(id)
    if (!v) return
    this.removeLabel(v)
    this.visuals.delete(id)
  }

  private nodePos(id: string, out = new THREE.Vector3()): THREE.Vector3 | null {
    const n = this.fgNodes.get(id)
    if (!n || n.x === undefined || n.y === undefined || n.z === undefined || Number.isNaN(n.x)) return null
    return out.set(n.x, n.y, n.z)
  }

  private tooltip(n: FNode): string {
    const pop = n.population ? populationOf(n.population) : null
    return `<div class="gl-tip"><b>${escapeHtml(n.label)}</b> <span>· ${escapeHtml(n.type)}${n.amount ? ` · $${Number(n.amount).toFixed(0)}` : ''}</span>${pop ? `<br><span style="color:${pop.color}">${escapeHtml(pop.label)}</span>` : ''}${n.flags?.length ? `<br><span>${escapeHtml(n.flags.join(', ').replace(/_/g, ' '))}</span>` : ''}</div>`
  }

  // ----- labels -------------------------------------------------------------------------------

  private setLabel(id: string, dotColor: string, text?: string) {
    if (!this.css2d) return
    const v = this.visuals.get(id)
    const n = this.fgNodes.get(id)
    if (!v || !n) return
    try {
      if (!v.label) {
        if (this.labelCount >= MAX_LABELS) return
        const div = document.createElement('div')
        div.className = 'gl-label'
        const obj = new CSS2DObject(div)
        obj.position.set(0, v.radius * 1.3 + 2.5, 0)
        v.group.add(obj)
        v.label = obj
        this.labelCount++
      }
      v.label.element.innerHTML = `<i style="background:${dotColor}"></i>${escapeHtml(text ?? shortLabel(n))}`
    } catch (err) {
      console.warn('[scene] label failed', err)
    }
  }

  private removeLabel(v: NodeVisual) {
    if (!v.label) return
    try {
      v.group.remove(v.label)
      v.label.element.remove()
    } catch {
      /* ignore */
    }
    v.label = null
    this.labelCount = Math.max(0, this.labelCount - 1)
  }

  // ----- highlights ---------------------------------------------------------------------------

  private mark(ids: string[], color: string, labelOverride?: Record<string, string>) {
    for (const id of ids) {
      if (!this.fgNodes.has(id)) continue
      const existing = this.marks.get(id)
      // Re-marking a node mid-animation restarts its timeline only if the previous attack is over.
      const text = labelOverride?.[id]
      if (!existing || this.t - existing.t0 > ATTACK_S) this.marks.set(id, { t0: this.t, color, text })
      else {
        existing.color = color
        if (text) existing.text = text
      }
      // Delta nodes get their three.js object on the next digest; frame() attaches the label then.
      this.setLabel(id, color, text)
    }
  }

  private tintEdges(ids: string[], color: string, opts: { onlyBetween?: boolean } = {}) {
    const set = new Set(ids)
    if (!set.size) return
    let changed = false
    for (const l of this.fgLinks.values()) {
      const s = idOf(l.source)
      const t = idOf(l.target)
      const hit = opts.onlyBetween ? set.has(s) && set.has(t) : set.has(s) || set.has(t)
      if (!hit) continue
      const fx = this.linkFx.get(l.key)
      if (fx) {
        fx.mat.color.set(color)
        fx.mat.opacity = EDGE_HOT
        fx.t0 = this.t
      } else {
        this.linkFx.set(l.key, { mat: new THREE.LineBasicMaterial({ color, transparent: true, opacity: EDGE_HOT, depthWrite: false }), t0: this.t })
      }
      changed = true
    }
    if (changed) this.refreshLinks()
  }

  private linkMaterialOf(l: FLink): THREE.Material {
    return this.linkFx.get(l.key)?.mat ?? this.defaultLinkMat
  }

  private refreshLinks() {
    try {
      this.graph.linkMaterial((l) => this.linkMaterialOf(l))
    } catch (err) {
      console.warn('[scene] link refresh failed', err)
    }
  }

  private clearHighlights() {
    for (const [id] of this.marks) {
      const v = this.visuals.get(id)
      if (!v) continue
      v.core.scale.setScalar(v.radius)
      v.outline.visible = false
      v.outlineMat.opacity = 0
    }
    this.marks.clear()
    for (const v of this.visuals.values()) this.removeLabel(v)
    for (const fx of this.linkFx.values()) fx.mat.dispose()
    this.linkFx.clear()
    this.refreshLinks()
  }

  private neighbours(id: string): string[] {
    const out = new Set<string>([id])
    for (const l of this.fgLinks.values()) {
      const s = idOf(l.source)
      const t = idOf(l.target)
      if (s === id) out.add(t)
      else if (t === id) out.add(s)
    }
    return [...out]
  }

  // ----- events -------------------------------------------------------------------------------

  onEvent(event: LiveEvent, state: State): void {
    if (this.disposed || !event || typeof event !== 'object') return
    try {
      switch (event.type) {
        case 'case.opened': {
          this.caseOrderId = event.order_id
          this.clearHighlights()
          const color = populationOf(event.population).color
          // Nodes may only exist after setGraph runs; mark and frame on the next frame.
          this.defer(() => {
            this.mark([event.order_id, event.customer_id], color, { [event.customer_id]: event.customer_name })
            this.tintEdges([event.order_id, event.customer_id], '#94A3B8', { onlyBetween: true })
            this.focusNeighbourhood(event.order_id)
          })
          break
        }
        case 'evidence.attached': {
          const ev = event.evidence
          if (!ev) break
          const color = AGENT_COLOR[event.agent] ?? AGENT_META[event.agent]?.color ?? UI.muted
          const ids = (ev.node_ids ?? []).filter((id): id is string => typeof id === 'string')
          this.defer(() => {
            this.mark(ids, color)
            this.tintEdges(ids, color)
          })
          break
        }
        case 'verdict': {
          const color = event.tier === 'decline' ? ACCENT.flagged : AGENT_COLOR.critic
          const ids = new Set<string>()
          for (const e of state.evidence) if (event.evidence_ids.includes(e.id)) for (const id of e.node_ids ?? []) ids.add(id)
          if (this.caseOrderId) {
            ids.add(this.caseOrderId)
            this.setLabel(this.caseOrderId, color, `${this.fgNodes.get(this.caseOrderId)?.label ?? this.caseOrderId} · ${event.tier.replace(/_/g, ' ')}`)
          }
          this.tintEdges([...ids], color, { onlyBetween: true })
          break
        }
        case 'dispute.routing': {
          this.defer(() => {
            if (!this.fgNodes.has(event.dispute_id)) return
            this.mark([event.dispute_id], ACCENT.flagged, { [event.dispute_id]: `${event.dispute_id} · ${event.decision.replace(/_/g, ' ')}` })
            this.tintEdges([event.dispute_id], ACCENT.flagged)
          })
          break
        }
        case 'reset': {
          this.caseOrderId = null
          this.pendingFocus = null
          this.clearHighlights()
          break
        }
        default:
          break
      }
    } catch (err) {
      console.warn('[scene] event handling failed', err)
    }
  }

  private defer(fn: () => void) {
    window.setTimeout(() => {
      if (this.disposed) return
      try {
        fn()
      } catch (err) {
        console.warn('[scene] deferred effect failed', err)
      }
    }, 0)
  }

  // ----- camera -------------------------------------------------------------------------------

  /** Frame a node and its 1-hop neighbourhood over 1.2s. Defers until the node has a position. */
  focusNeighbourhood(id: string, ms = 1200): void {
    const center = this.nodePos(id)
    if (!center) {
      this.pendingFocus = id
      return
    }
    this.pendingFocus = null
    const pts: THREE.Vector3[] = []
    for (const nid of this.neighbours(id)) {
      const p = this.nodePos(nid)
      if (p) pts.push(p)
    }
    const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / Math.max(1, pts.length))
    const centroid = c.lerp(center, 0.4)
    let radius = 8
    for (const p of pts) radius = Math.max(radius, p.distanceTo(centroid) + 4)
    const cam = this.graph.camera() as THREE.PerspectiveCamera
    const fov = ((cam && 'fov' in cam ? cam.fov : 75) * Math.PI) / 180
    const distance = Math.max(80, (radius / Math.tan(fov / 2)) * 1.25 + 30)
    const dir = cam.position.clone().sub(centroid)
    if (dir.length() < 1) dir.set(0.4, 0.3, 1)
    dir.normalize()
    dir.y = Math.max(dir.y, 0.22)
    dir.normalize()
    const pos = centroid.clone().add(dir.multiplyScalar(distance))
    this.pauseOrbit(ms / 1000 + 1.5)
    try {
      this.graph.cameraPosition({ x: pos.x, y: pos.y, z: pos.z }, { x: centroid.x, y: centroid.y, z: centroid.z }, REDUCED_MOTION ? 0 : ms)
    } catch (err) {
      console.warn('[scene] camera move failed', err)
    }
  }

  focusOverview(): void {
    this.pauseOrbit(2.4)
    try {
      this.graph.zoomToFit(REDUCED_MOTION ? 0 : 1600, 60)
    } catch {
      this.graph.cameraPosition({ x: 0, y: 70, z: 440 }, { x: 0, y: 0, z: 0 }, REDUCED_MOTION ? 0 : 1600)
    }
  }

  private pauseOrbit(seconds: number) {
    if (!this.controls) return
    this.controls.autoRotate = false
    if (!this.dragging) this.resumeOrbitAt = this.t + seconds
  }

  resize(): void {
    if (this.disposed) return
    const w = Math.max(1, this.container.clientWidth)
    const h = Math.max(1, this.container.clientHeight)
    try {
      this.graph.width(w).height(h)
    } catch {
      /* ignore */
    }
  }

  // ----- per-frame ----------------------------------------------------------------------------

  frame(_state: State, dt: number): void {
    if (this.disposed) return
    dt = Math.min(0.1, Math.max(0, dt))
    this.t += dt
    const t = this.t

    if (this.controls) {
      if (this.resumeOrbitAt !== null && t >= this.resumeOrbitAt && !this.dragging && !REDUCED_MOTION) {
        this.resumeOrbitAt = null
        this.controls.autoRotate = true
      }
      // Light fog scaled to the viewing distance so depth reads at any zoom.
      try {
        const cam = this.graph.camera()
        const dist = cam.position.distanceTo(this.controls.target)
        this.fog.near = dist * 0.8
        this.fog.far = dist * 2.6
      } catch {
        /* ignore */
      }
    }

    if (this.pendingFocus && this.nodePos(this.pendingFocus)) this.focusNeighbourhood(this.pendingFocus)

    // Node highlight timelines: attack to 1.6x, hold, settle to a subtle persistent outline.
    for (const [id, m] of this.marks) {
      const v = this.visuals.get(id)
      if (!v) continue
      if (!v.label && this.css2d && this.labelCount < MAX_LABELS) this.setLabel(id, m.color, m.text)
      const age = t - m.t0
      let scale: number
      let outline: number
      if (age < ATTACK_S) {
        const k = easeOut(age / ATTACK_S)
        scale = 1 + (PEAK_SCALE - 1) * k
        outline = 0.35 * k
      } else if (age < HOLD_S) {
        scale = PEAK_SCALE
        outline = 0.35
      } else if (age < HOLD_S + SETTLE_S) {
        const k = easeOut((age - HOLD_S) / SETTLE_S)
        scale = PEAK_SCALE + (REST_SCALE - PEAK_SCALE) * k
        outline = 0.35 + (0.55 - 0.35) * k
      } else {
        scale = REST_SCALE
        outline = 0.55
      }
      v.core.scale.setScalar(v.radius * scale)
      v.outline.scale.setScalar(v.radius * scale * 1.22)
      v.outline.visible = true
      v.outlineMat.opacity = outline
    }

    // Edge tints: agent colour at 0.9 for three seconds, then settle to a persistent half-tone.
    for (const fx of this.linkFx.values()) {
      const age = t - fx.t0
      if (age < HOLD_S) fx.mat.opacity = EDGE_HOT
      else if (age < HOLD_S + SETTLE_S) fx.mat.opacity = EDGE_HOT + (EDGE_REST - EDGE_HOT) * easeOut((age - HOLD_S) / SETTLE_S)
      else fx.mat.opacity = EDGE_REST
    }
  }

  get isSettled(): boolean {
    return this.settled
  }

  destroy(): void {
    this.disposed = true
    window.removeEventListener('resize', this.onWindowResize)
    this.resizeObserver?.disconnect()
    for (const v of this.visuals.values()) this.removeLabel(v)
    for (const fx of this.linkFx.values()) fx.mat.dispose()
    this.linkFx.clear()
    try {
      this.graph._destructor()
    } catch {
      /* ignore */
    }
  }
}
