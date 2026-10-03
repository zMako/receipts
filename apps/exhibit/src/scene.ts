/**
 * The three.js evidence graph, rendered as a restrained, matte, light-theme scene.
 *
 * Reading hierarchy, in order:
 *   1. Only nodes that carry information are drawn: customers, orders, devices/addresses/cards that
 *      are SHARED between accounts (linkage), the Muse sandbox device, and the active case's
 *      returns, disputes and evidence nodes. Single-use leaves stay hidden.
 *   2. The layout is designed, not simulated: customers on a golden-angle spiral with their orders
 *      ringed around them, linked accounts side by side, the Muse sandbox hub at the centre. Every
 *      node sits on a floor with a contact shadow. Nothing moves after first paint except the camera.
 *   3. When a case opens, everything outside its two-hop neighbourhood fades to a ghost.
 *   4. Links are thin tubes; the case's links take the agent's colour as evidence lands.
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
  ring: THREE.Mesh | null
  radius: number
  label: CSS2DObject | null
  /** Permanent label (shared leaf, sandbox) that survives highlight clears. */
  pinnedLabel: string | null
  targetOpacity: number
}

/** Highlight timeline for a node: scale-up over 400ms, hold, settle into the persistent outline. */
interface Mark {
  t0: number
  color: string
  text?: string
}

interface LinkMat {
  mat: THREE.MeshBasicMaterial
  /** Set when an agent tinted the edge; undefined for a plain structural edge. */
  fxT0?: number
  targetOpacity: number
}

const CARD_BG = 0xffffff
const ATTACK_S = 0.4
const HOLD_S = 3.0
const SETTLE_S = 0.4
const PEAK_SCALE = 1.6
const REST_SCALE = 1.12
const EDGE_HOT = 0.95
const EDGE_REST = 0.6
const EDGE_BASE = 0.55
const EDGE_HUB = 0.22
const EDGE_GHOST = 0.07
const NODE_GHOST = 0.16
const MAX_LABELS = 40
/** OrbitControls: 2.0 is one revolution per 30s at 60fps; we want one per four minutes. */
const ORBIT_SPEED = 2.0 * (30 / 240)
const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const LEAF_TYPES: ReadonlySet<NodeType> = new Set(['device', 'address', 'payment'])
const SATELLITE_TYPES: ReadonlySet<NodeType> = new Set(['return', 'dispute', 'evidence'])

const NEUTRAL: Record<NodeType, string> = {
  customer: UI.neutralNode,
  order: ACCENT.human,
  device: '#94A3B8',
  address: '#94A3B8',
  payment: '#94A3B8',
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
const lerp = (a: number, b: number, k: number) => a + (b - a) * k

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

function makeRadialTexture(inner: string, outer: string): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 512
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(256, 256, 0, 256, 256, 256)
  g.addColorStop(0, inner)
  g.addColorStop(0.75, outer)
  g.addColorStop(1, outer)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 512, 512)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function leafNoun(type: NodeType): string {
  return type === 'device' ? 'device' : type === 'address' ? 'address' : 'card'
}

export class ExhibitScene {
  readonly graph: ForceGraph3DInstance<FNode, FLink>
  private readonly container: HTMLElement
  private readonly fgNodes = new Map<string, FNode>()
  private readonly fgLinks = new Map<string, FLink>()
  private readonly visuals = new Map<string, NodeVisual>()
  private readonly marks = new Map<string, Mark>()
  private readonly linkMats = new Map<string, LinkMat>()
  private readonly geo: Record<string, THREE.BufferGeometry>
  private readonly fog: THREE.Fog
  private readonly css2d: CSS2DRenderer | null
  /** Ids that exist only because the active case touched them (evidence node_ids, satellites). */
  private readonly caseTouched = new Set<string>()
  private readonly floor: THREE.Mesh
  private readonly spot: THREE.Mesh
  private readonly spotMat: THREE.MeshBasicMaterial
  private spotTarget = 0
  private caseOrderId: string | null = null
  private caseCustomerId: string | null = null
  private focusSet: Set<string> | null = null
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
      leaf: new THREE.OctahedronGeometry(1, 0),
      address: new THREE.CylinderGeometry(1, 1, 0.3, 24),
      payment: new THREE.BoxGeometry(1.5, 1.5, 1.5),
      return: new THREE.TorusGeometry(1, 0.28, 10, 28),
      ring: new THREE.TorusGeometry(1, 0.05, 8, 56),
      outline: new THREE.SphereGeometry(1, 28, 20),
      shadow: new THREE.CircleGeometry(1, 28),
    }
    this.fog = new THREE.Fog(CARD_BG, 300, 1100)

    // A faint radial floor under the map and a spotlight disc that slides under the active case.
    const floorTex = makeRadialTexture('#e9edf3', '#ffffff')
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(1, 96), new THREE.MeshBasicMaterial({ map: floorTex, transparent: true, depthWrite: false }))
    this.floor.rotation.x = -Math.PI / 2
    this.floor.position.y = -0.6
    this.floor.scale.setScalar(320)
    this.floor.renderOrder = -2
    this.spotMat = new THREE.MeshBasicMaterial({ color: ACCENT.human, transparent: true, opacity: 0, depthWrite: false })
    this.spot = new THREE.Mesh(new THREE.CircleGeometry(1, 64), this.spotMat)
    this.spot.rotation.x = -Math.PI / 2
    this.spot.position.y = -0.4
    this.spot.renderOrder = -1
    this.spot.visible = false

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
      .linkWidth((l) => this.linkWidthOf(l))
      .linkResolution(5)
      .linkOpacity(1)
      .linkMaterial((l) => this.linkMaterialOf(l))
      .enableNodeDrag(false)
      .onNodeClick((n) => n && this.focusNeighbourhood(n.id))
      .warmupTicks(0)
      .cooldownTicks(0)
      .onEngineStop(() => this.onSettled())

    // Positions are authored, every node is pinned: the forces never run.
    const charge = graph.d3Force('charge')
    if (charge && typeof charge.strength === 'function') charge.strength(0)

    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(0.6, 1.8, 0.9)
    const fill = new THREE.DirectionalLight(0xffffff, 0.4)
    fill.position.set(-1, 0.6, -1)
    graph.lights([new THREE.HemisphereLight(0xffffff, 0xdfe5ee, 2.2), key, fill])

    const scene = graph.scene()
    scene.fog = this.fog
    scene.add(this.floor, this.spot)

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
      // Always above the ground plane: between 20 and 72 degrees of elevation.
      controls.minPolarAngle = 0.32
      controls.maxPolarAngle = 1.22
      controls.addEventListener('start', () => {
        this.dragging = true
        controls.autoRotate = false
        this.resumeOrbitAt = null
      })
      controls.addEventListener('end', () => {
        this.dragging = false
        this.resumeOrbitAt = this.t + 8
      })
    }

    graph.cameraPosition({ x: 0, y: 330, z: 240 }, { x: 0, y: 0, z: 0 }, 0)

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize())
      this.resizeObserver.observe(container)
    }
    window.addEventListener('resize', this.onWindowResize)
  }

  // ----- what to show -------------------------------------------------------------------------

  /**
   * The subgraph worth drawing. Leaves are shown only when shared across accounts (or the sandbox
   * cluster, or touched by the case); returns and disputes only for the case; delta nodes always.
   */
  private visibleSubgraph(state: State): { nodes: GNode[]; edges: State['graph']['edges']; leafAccounts: Map<string, number> } {
    const g = state.graph
    const customerOfOrder = new Map<string, string>()
    for (const e of g.edges) if (e.type === 'placed') customerOfOrder.set(e.target, e.source)
    const accountsByLeaf = new Map<string, Set<string>>()
    const orderOfSatellite = new Map<string, string>()
    for (const e of g.edges) {
      const t = g.byId[e.target]
      if (!t) continue
      if (LEAF_TYPES.has(t.type)) {
        const c = customerOfOrder.get(e.source)
        if (c) accountsByLeaf.set(e.target, (accountsByLeaf.get(e.target) ?? new Set()).add(c))
      } else if (SATELLITE_TYPES.has(t.type)) orderOfSatellite.set(e.target, e.source)
    }
    const leafAccounts = new Map<string, number>()
    for (const [id, set] of accountsByLeaf) leafAccounts.set(id, set.size)

    const visible = new Set<string>()
    for (const n of g.nodes) {
      if (n.delta || this.caseTouched.has(n.id)) visible.add(n.id)
      else if (n.type === 'customer' || n.type === 'order') visible.add(n.id)
      else if (LEAF_TYPES.has(n.type)) {
        if (n.population === 'cluster' || (leafAccounts.get(n.id) ?? 0) >= 2) visible.add(n.id)
        else if (this.caseOrderId && g.edges.some((e) => e.source === this.caseOrderId && e.target === n.id)) visible.add(n.id)
      } else if (SATELLITE_TYPES.has(n.type)) {
        if (this.caseOrderId && orderOfSatellite.get(n.id) === this.caseOrderId) visible.add(n.id)
      }
    }
    return { nodes: g.nodes.filter((n) => visible.has(n.id)), edges: g.edges.filter((e) => visible.has(e.source) && visible.has(e.target)), leafAccounts }
  }

  // ----- graph data ---------------------------------------------------------------------------

  /** Sync force-graph node/link objects with the reducer's graph. Objects are kept stable so layout survives. */
  setGraph(state: State): void {
    if (this.disposed) return
    const { nodes, edges, leafAccounts } = this.visibleSubgraph(state)
    const first = this.fgNodes.size === 0 && nodes.length > 0
    let changed = false
    const seen = new Set<string>()
    const added: FNode[] = []
    for (const n of nodes) {
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
    for (const e of edges) {
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
        const lm = this.linkMats.get(key)
        if (lm) {
          lm.mat.dispose()
          this.linkMats.delete(key)
        }
        changed = true
      }
    }
    // Shared leaves carry a permanent label with how many accounts meet there.
    for (const [id, count] of leafAccounts) {
      const v = this.visuals.get(id)
      const n = this.fgNodes.get(id)
      if (!v || !n || count < 2 || n.population === 'cluster') continue
      const text = `${count} accounts, one ${leafNoun(n.type)}`
      if (v.pinnedLabel !== text) {
        v.pinnedLabel = text
        this.setLabel(id, ACCENT.flagged, text)
      }
    }
    if (!changed) {
      this.applyFocus()
      return
    }

    // Designed layout: every node gets an authored, pinned position. New nodes slot in next to
    // their parent order without touching anything else.
    this.layout(first ? [...this.fgNodes.values()] : added)
    this.graph.warmupTicks(0).cooldownTicks(0)
    try {
      this.graph.graphData({ nodes: [...this.fgNodes.values()], links: [...this.fgLinks.values()] })
    } catch (err) {
      console.warn('[scene] graphData failed', err)
    }
    this.applyFocus()
  }

  // ----- layout ---------------------------------------------------------------------------------

  /**
   * Customers sit on a golden-angle spiral, interesting ones (flags, agent orders, linked accounts)
   * towards the centre and linked accounts adjacent; orders ring their customer; shared leaves sit at
   * the centroid of the accounts they join; the sandbox hub is the origin; satellites ring their order.
   */
  private layout(targets: FNode[]) {
    const all = [...this.fgNodes.values()]
    const byId = this.fgNodes
    const custOrders = new Map<string, FNode[]>()
    const parentOf = new Map<string, string>()
    for (const l of this.fgLinks.values()) {
      const sId = idOf(l.source)
      const tId = idOf(l.target)
      const sN = byId.get(sId)
      const tN = byId.get(tId)
      if (!sN || !tN) continue
      if (l.type === 'placed') custOrders.set(sId, [...(custOrders.get(sId) ?? []), tN])
      else if (sN.type === 'order') parentOf.set(tId, sId)
    }
    const targetSet = new Set(targets.map((n) => n.id))
    const place = (n: FNode, x: number, z: number) => {
      const r = this.styleOf(n).radius
      n.x = x
      n.z = z
      n.y = r
      n.fx = x
      n.fz = z
      n.fy = r
    }

    // 1. Customers, only when laying out from scratch (their spots never change afterwards).
    const customers = all.filter((n) => n.type === 'customer')
    if (customers.some((c) => targetSet.has(c.id))) {
      // Union linked accounts through shared leaves so they land next to each other on the spiral.
      const parent = new Map<string, string>()
      const find = (a: string): string => {
        let x = a
        while (parent.get(x) && parent.get(x) !== x) x = parent.get(x)!
        return x
      }
      for (const c of customers) parent.set(c.id, c.id)
      const leafCustomers = new Map<string, string[]>()
      for (const l of this.fgLinks.values()) {
        const t = byId.get(idOf(l.target))
        const o = byId.get(idOf(l.source))
        if (!t || !o || o.type !== 'order' || !LEAF_TYPES.has(t.type) || t.population === 'cluster') continue
        const owner = [...custOrders.entries()].find(([, os]) => os.some((x) => x.id === o.id))?.[0]
        if (owner) leafCustomers.set(t.id, [...(leafCustomers.get(t.id) ?? []), owner])
      }
      for (const cs of leafCustomers.values()) for (let i = 1; i < cs.length; i++) parent.set(find(cs[i]), find(cs[0]))
      const interest = (c: FNode) => {
        const os = custOrders.get(c.id) ?? []
        let score = 0
        for (const o of os) {
          if (o.population && o.population !== 'human') score += 2
          score += (o.flags ?? []).filter((f) => f !== 'established_low_risk').length
        }
        if ((leafCustomers.size && [...leafCustomers.values()].some((cs) => cs.length >= 2 && cs.includes(c.id)))) score += 6
        return score
      }
      const groups = new Map<string, FNode[]>()
      for (const c of customers) groups.set(find(c.id), [...(groups.get(find(c.id)) ?? []), c])
      const ordered = [...groups.values()]
        .map((g) => ({ g, score: g.reduce((m, c) => Math.max(m, interest(c)), 0), tie: hash(g[0].id) }))
        .sort((a, b) => b.score - a.score || a.tie - b.tie)
        .flatMap((x) => x.g)
      const GOLDEN = Math.PI * (3 - Math.sqrt(5))
      ordered.forEach((c, i) => {
        const k = i + 2 // leave the centre for the hub
        const r = 27 * Math.sqrt(k)
        const theta = k * GOLDEN
        place(c, r * Math.cos(theta), r * Math.sin(theta))
      })
    }

    // 2. Orders ring their customer.
    for (const [cid, os] of custOrders) {
      const c = byId.get(cid)
      if (!c || c.x === undefined) continue
      const sorted = [...os].sort((a, b) => a.id.localeCompare(b.id))
      const ringR = sorted.length <= 3 ? 9 : sorted.length <= 8 ? 11.5 : 14.5
      const rot = (hash(cid) % 360) * (Math.PI / 180)
      sorted.forEach((o, i) => {
        if (!targetSet.has(o.id) && o.x !== undefined) return
        const a = rot + (i / sorted.length) * Math.PI * 2
        place(o, c.x! + ringR * Math.cos(a), c.z! + ringR * Math.sin(a))
      })
    }

    // 3. The hub at the origin; shared leaves at the centroid of the orders they join; case leaves and
    //    satellites on a small ring around their order.
    const satIndex = new Map<string, number>()
    for (const n of all) {
      if (n.type === 'customer' || n.type === 'order') continue
      if (!targetSet.has(n.id) && n.x !== undefined) continue
      if (n.population === 'cluster') {
        place(n, 0, 0)
        continue
      }
      const linkedOrders: FNode[] = []
      for (const l of this.fgLinks.values()) {
        if (idOf(l.target) !== n.id) continue
        const o = byId.get(idOf(l.source))
        if (o && o.x !== undefined) linkedOrders.push(o)
      }
      if (LEAF_TYPES.has(n.type) && linkedOrders.length >= 2) {
        const cx = linkedOrders.reduce((a, o) => a + o.x!, 0) / linkedOrders.length
        const cz = linkedOrders.reduce((a, o) => a + o.z!, 0) / linkedOrders.length
        const r = rng(hash(n.id))
        place(n, cx + (r() - 0.5) * 6, cz + (r() - 0.5) * 6)
        continue
      }
      const parentId = parentOf.get(n.id) ?? linkedOrders[0]?.id
      const o = parentId ? byId.get(parentId) : undefined
      if (o && o.x !== undefined) {
        const i = satIndex.get(o.id) ?? 0
        satIndex.set(o.id, i + 1)
        const a = (hash(o.id) % 360) * (Math.PI / 180) + Math.PI / 4 + i * (Math.PI / 2.4)
        place(n, o.x + 8 * Math.cos(a), (o.z ?? 0) + 8 * Math.sin(a))
      } else {
        const r = rng(hash(n.id))
        place(n, (r() - 0.5) * 40, (r() - 0.5) * 40)
      }
    }
  }

  private onSettled() {
    if (!this.settled) {
      this.settled = true
      if (this.caseOrderId) this.focusNeighbourhood(this.caseOrderId)
      else {
        try {
          this.graph.zoomToFit(0, 50)
        } catch {
          /* no nodes yet */
        }
      }
    }
  }

  // ----- node visuals -------------------------------------------------------------------------

  private styleOf(n: FNode): { color: string; geo: THREE.BufferGeometry; radius: number; ring: string | null } {
    if (n.type === 'device' && n.population === 'cluster') return { color: ACCENT.cluster, geo: this.geo.sphere, radius: 2.6, ring: ACCENT.cluster }
    if (n.type === 'order') {
      const amount = Number(n.amount) || 120
      const radius = Math.max(2.1, Math.min(4.8, 1.5 + 0.13 * Math.sqrt(amount)))
      const flagged = (n.flags ?? []).some((f) => f !== 'established_low_risk' && f !== 'undeclared_agent' && f !== 'declared_unsigned_agent')
      return { color: n.population ? populationOf(n.population).color : NEUTRAL.order, geo: this.geo.sphere, radius, ring: flagged ? ACCENT.flagged : null }
    }
    if (n.type === 'customer') return { color: NEUTRAL.customer, geo: this.geo.sphere, radius: 3.6, ring: null }
    if (n.type === 'device') return { color: NEUTRAL.device, geo: this.geo.leaf, radius: 2.0, ring: null }
    if (n.type === 'address') return { color: NEUTRAL.address, geo: this.geo.address, radius: 2.2, ring: null }
    if (n.type === 'payment') return { color: NEUTRAL.payment, geo: this.geo.payment, radius: 1.5, ring: null }
    if (n.type === 'return') return { color: NEUTRAL.return, geo: this.geo.return, radius: 1.9, ring: null }
    if (n.type === 'dispute') return { color: NEUTRAL.dispute, geo: this.geo.sphere, radius: 2.0, ring: null }
    return { color: NEUTRAL.evidence, geo: this.geo.leaf, radius: 1.6, ring: null }
  }

  private buildNode(n: FNode): THREE.Object3D {
    const st = this.styleOf(n)
    const mat = new THREE.MeshStandardMaterial({ color: st.color, roughness: 0.9, metalness: 0, transparent: true, opacity: 1 })
    const core = new THREE.Mesh(st.geo, mat)
    core.scale.setScalar(st.radius)
    if (n.type === 'return') core.rotation.x = Math.PI / 2
    const outlineMat = new THREE.MeshBasicMaterial({ color: darker(st.color), side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false })
    const outline = new THREE.Mesh(this.geo.outline, outlineMat)
    outline.scale.setScalar(st.radius * 1.22)
    outline.visible = false
    const group = new THREE.Group()
    group.add(core, outline)
    // Contact shadow on the floor: the node's centre sits at y = radius, so the floor is at -radius.
    const shadow = new THREE.Mesh(this.geo.shadow, new THREE.MeshBasicMaterial({ color: 0x0f172a, transparent: true, opacity: 0.09, depthWrite: false }))
    shadow.rotation.x = -Math.PI / 2
    shadow.position.y = -st.radius + 0.25
    shadow.scale.setScalar(st.radius * 1.15)
    group.add(shadow)
    let ring: THREE.Mesh | null = null
    if (st.ring) {
      // A flat halo on the ground plane: flagged orders red, the sandbox device pink.
      ring = new THREE.Mesh(this.geo.ring, new THREE.MeshBasicMaterial({ color: st.ring, transparent: true, opacity: 0.8, depthWrite: false }))
      ring.scale.setScalar(st.radius * 1.9)
      ring.rotation.x = Math.PI / 2
      ring.position.y = -st.radius + 0.5
      group.add(ring)
    }
    this.dropVisual(n.id)
    const prevOpacity = this.focusSet ? (this.focusSet.has(n.id) ? 1 : NODE_GHOST) : 1
    mat.opacity = prevOpacity
    if (ring) (ring.material as THREE.MeshBasicMaterial).opacity = 0.8 * prevOpacity
    this.visuals.set(n.id, { group, core, mat, outline, outlineMat, ring, radius: st.radius, label: null, pinnedLabel: null, targetOpacity: prevOpacity })
    if (n.type === 'device' && n.population === 'cluster') {
      const v = this.visuals.get(n.id)!
      v.pinnedLabel = 'Muse sandbox, shared by 37 orders'
      this.setLabel(n.id, ACCENT.cluster, v.pinnedLabel)
    }
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
    if (!n || n.x === undefined || n.z === undefined || Number.isNaN(n.x)) return null
    return out.set(n.x, n.y ?? 0, n.z)
  }

  private tooltip(n: FNode): string {
    const pop = n.population ? populationOf(n.population) : null
    const meta = [n.type, n.amount ? `$${Number(n.amount).toFixed(0)}` : ''].filter(Boolean).join(', ')
    return `<div class="gl-tip"><b>${escapeHtml(n.label)}</b> <span>${escapeHtml(meta)}</span>${pop ? `<br><span style="color:${pop.color}">${escapeHtml(pop.label)}</span>` : ''}${n.flags?.length ? `<br><span>${escapeHtml(n.flags.join(', ').replace(/_/g, ' '))}</span>` : ''}</div>`
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
      v.label.element.innerHTML = `<i style="background:${dotColor}"></i>${escapeHtml(text ?? v.pinnedLabel ?? shortLabel(n))}`
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

  // ----- highlights and focus -----------------------------------------------------------------

  private mark(ids: string[], color: string, labelOverride?: Record<string, string>) {
    for (const id of ids) {
      if (!this.fgNodes.has(id)) continue
      const existing = this.marks.get(id)
      const text = labelOverride?.[id]
      if (!existing || this.t - existing.t0 > ATTACK_S) this.marks.set(id, { t0: this.t, color, text })
      else {
        existing.color = color
        if (text) existing.text = text
      }
      this.setLabel(id, color, text)
    }
  }

  private linkMatOf(key: string): LinkMat {
    let lm = this.linkMats.get(key)
    if (!lm) {
      const l = this.fgLinks.get(key)
      const base = l && this.isHubLink(l) ? EDGE_HUB : EDGE_BASE
      lm = { mat: new THREE.MeshBasicMaterial({ color: l && this.isHubLink(l) ? ACCENT.cluster : UI.edge, transparent: true, opacity: base, depthWrite: false }), targetOpacity: base }
      this.linkMats.set(key, lm)
    }
    return lm
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
      const lm = this.linkMatOf(l.key)
      lm.mat.color.set(color)
      lm.mat.opacity = EDGE_HOT
      lm.fxT0 = this.t
      changed = true
    }
    if (changed) this.refreshLinks()
  }

  private linkMaterialOf(l: FLink): THREE.Material {
    return this.linkMatOf(l.key).mat
  }

  private linkWidthOf(l: FLink): number {
    const lm = this.linkMats.get(l.key)
    if (lm?.fxT0 !== undefined) return 1.1
    if (this.isHubLink(l)) return 0.3
    const s = idOf(l.source)
    const t = idOf(l.target)
    if (this.focusSet && this.focusSet.has(s) && this.focusSet.has(t)) return 0.7
    return 0.45
  }

  private refreshLinks() {
    try {
      this.graph.linkMaterial((l) => this.linkMaterialOf(l)).linkWidth((l) => this.linkWidthOf(l))
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
    for (const [id, v] of this.visuals) {
      if (v.pinnedLabel) this.setLabel(id, this.fgNodes.get(id)?.population === 'cluster' ? ACCENT.cluster : ACCENT.flagged, v.pinnedLabel)
      else this.removeLabel(v)
    }
    for (const [key, lm] of this.linkMats) {
      lm.fxT0 = undefined
      const l = this.fgLinks.get(key)
      const hub = l ? this.isHubLink(l) : false
      lm.mat.color.set(hub ? ACCENT.cluster : UI.edge)
      lm.mat.opacity = hub ? EDGE_HUB : EDGE_BASE
    }
    this.refreshLinks()
  }

  private isHub(id: string): boolean {
    return this.fgNodes.get(id)?.population === 'cluster'
  }

  private isHubLink(l: FLink): boolean {
    return this.isHub(idOf(l.source)) || this.isHub(idOf(l.target))
  }

  /** Direct neighbours. The sandbox hub is included as a node but never expanded through. */
  private neighbours(id: string): string[] {
    const out = new Set<string>([id])
    if (this.isHub(id)) return [...out]
    for (const l of this.fgLinks.values()) {
      const s = idOf(l.source)
      const t = idOf(l.target)
      if (s === id) out.add(t)
      else if (t === id) out.add(s)
    }
    return [...out]
  }

  /** Two hops around the case order plus everything the case touched; null when no case is open. */
  private computeFocus(): Set<string> | null {
    if (!this.caseOrderId) return null
    const set = new Set<string>([this.caseOrderId])
    if (this.caseCustomerId) set.add(this.caseCustomerId)
    for (const id of this.neighbours(this.caseOrderId)) set.add(id)
    for (const id of [...set]) for (const nb of this.neighbours(id)) set.add(nb)
    for (const id of this.caseTouched) set.add(id)
    for (const id of this.marks.keys()) set.add(id)
    return set
  }

  /** Ghost everything outside the focus set. Opacities ease per frame towards their targets. */
  private applyFocus() {
    this.focusSet = this.computeFocus()
    let widthChanged = false
    for (const [id, v] of this.visuals) {
      const target = this.focusSet ? (this.focusSet.has(id) ? 1 : NODE_GHOST) : 1
      if (v.targetOpacity !== target) v.targetOpacity = target
    }
    for (const l of this.fgLinks.values()) {
      const lm = this.linkMatOf(l.key)
      const inFocus = !this.focusSet || (this.focusSet.has(idOf(l.source)) && this.focusSet.has(idOf(l.target)))
      const base = this.isHubLink(l) ? EDGE_HUB : EDGE_BASE
      const target = lm.fxT0 !== undefined ? lm.targetOpacity : inFocus ? base : EDGE_GHOST
      if (lm.targetOpacity !== target) {
        lm.targetOpacity = target
        widthChanged = true
      }
    }
    if (widthChanged) this.refreshLinks()
  }

  // ----- events -------------------------------------------------------------------------------

  onEvent(event: LiveEvent, state: State): void {
    if (this.disposed || !event || typeof event !== 'object') return
    try {
      switch (event.type) {
        case 'case.opened': {
          this.caseOrderId = event.order_id
          this.caseCustomerId = event.customer_id
          this.caseTouched.clear()
          this.caseTouched.add(event.order_id).add(event.customer_id)
          this.clearHighlights()
          const color = populationOf(event.population).color
          this.defer(() => {
            this.mark([event.order_id, event.customer_id], color, { [event.customer_id]: event.customer_name })
            this.tintEdges([event.order_id, event.customer_id], '#94A3B8', { onlyBetween: true })
            this.focusNeighbourhood(event.order_id)
            this.spotlight(event.order_id, color)
          })
          break
        }
        case 'evidence.attached': {
          const ev = event.evidence
          if (!ev) break
          const color = AGENT_COLOR[event.agent] ?? AGENT_META[event.agent]?.color ?? UI.muted
          const ids = (ev.node_ids ?? []).filter((id): id is string => typeof id === 'string')
          for (const id of ids) this.caseTouched.add(id)
          for (const n of ev.graph?.nodes ?? []) this.caseTouched.add(n.id)
          this.defer(() => {
            this.mark(ids, color)
            this.tintEdges(ids, color)
            this.applyFocus()
          })
          break
        }
        case 'verdict': {
          const color = event.tier === 'decline' ? ACCENT.flagged : AGENT_COLOR.critic
          const ids = new Set<string>()
          for (const e of state.evidence) if (event.evidence_ids.includes(e.id)) for (const id of e.node_ids ?? []) ids.add(id)
          if (this.caseOrderId) {
            ids.add(this.caseOrderId)
            this.setLabel(this.caseOrderId, color, `${this.fgNodes.get(this.caseOrderId)?.label ?? this.caseOrderId}: ${event.tier.replace(/_/g, ' ')}`)
          }
          this.tintEdges([...ids], color, { onlyBetween: true })
          break
        }
        case 'dispute.routing': {
          this.caseTouched.add(event.dispute_id)
          this.defer(() => {
            if (!this.fgNodes.has(event.dispute_id)) return
            this.mark([event.dispute_id], ACCENT.flagged, { [event.dispute_id]: `${event.dispute_id}: ${event.decision.replace(/_/g, ' ')}` })
            this.tintEdges([event.dispute_id], ACCENT.flagged)
          })
          break
        }
        case 'reset': {
          this.caseOrderId = null
          this.caseCustomerId = null
          this.caseTouched.clear()
          this.pendingFocus = null
          this.clearHighlights()
          this.applyFocus()
          this.spotTarget = 0
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

  /** Frame a node and its 1-hop neighbourhood from a fixed elevation. Defers until the node has a position. */
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
    let radius = 10
    for (const p of pts) radius = Math.max(radius, p.distanceTo(centroid) + 6)
    const cam = this.graph.camera() as THREE.PerspectiveCamera
    const fov = ((cam && 'fov' in cam ? cam.fov : 75) * Math.PI) / 180
    const distance = Math.max(90, (radius / Math.tan(fov / 2)) * 1.3 + 30)
    // Keep the current azimuth, fix the elevation at about 50 degrees so the map stays readable.
    const flat = new THREE.Vector3(cam.position.x - centroid.x, 0, cam.position.z - centroid.z)
    if (flat.length() < 1) flat.set(0, 0, 1)
    flat.normalize()
    const elev = 0.87
    const dir = new THREE.Vector3(flat.x * Math.cos(elev), Math.sin(elev), flat.z * Math.cos(elev))
    const pos = centroid.clone().add(dir.multiplyScalar(distance))
    this.pauseOrbit(ms / 1000 + 1.5)
    try {
      this.graph.cameraPosition({ x: pos.x, y: pos.y, z: pos.z }, { x: centroid.x, y: centroid.y, z: centroid.z }, REDUCED_MOTION ? 0 : ms)
    } catch (err) {
      console.warn('[scene] camera move failed', err)
    }
  }

  /** A soft coloured disc on the floor under the case cluster. */
  private spotlight(orderId: string, color: string) {
    const pts: THREE.Vector3[] = []
    for (const id of this.neighbours(orderId)) {
      const p = this.nodePos(id)
      if (p) pts.push(p)
    }
    const c = this.nodePos(orderId)
    if (!c || !pts.length) return
    const customerPos = pts.find((p) => p !== c)
    const centre = customerPos ? c.clone().lerp(customerPos, 0.5) : c
    let radius = 12
    for (const p of pts) radius = Math.max(radius, Math.hypot(p.x - centre.x, p.z - centre.z) + 8)
    this.spot.position.set(centre.x, -0.4, centre.z)
    this.spot.scale.setScalar(radius)
    this.spotMat.color.set(color)
    this.spot.visible = true
    this.spotTarget = 0.1
  }

  focusOverview(): void {
    this.pauseOrbit(2.4)
    try {
      this.graph.zoomToFit(REDUCED_MOTION ? 0 : 1600, 50)
    } catch {
      this.graph.cameraPosition({ x: 0, y: 330, z: 240 }, { x: 0, y: 0, z: 0 }, REDUCED_MOTION ? 0 : 1600)
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
    const k = 1 - Math.exp(-dt * 6)

    if (this.controls) {
      if (this.resumeOrbitAt !== null && t >= this.resumeOrbitAt && !this.dragging && !REDUCED_MOTION) {
        this.resumeOrbitAt = null
        this.controls.autoRotate = true
      }
      try {
        const cam = this.graph.camera()
        const dist = cam.position.distanceTo(this.controls.target)
        this.fog.near = dist * 0.9
        this.fog.far = dist * 3.0
      } catch {
        /* ignore */
      }
    }

    if (this.pendingFocus && this.nodePos(this.pendingFocus)) this.focusNeighbourhood(this.pendingFocus)

    // Spotlight fade.
    if (Math.abs(this.spotMat.opacity - this.spotTarget) > 0.001) {
      this.spotMat.opacity = lerp(this.spotMat.opacity, this.spotTarget, k)
      if (this.spotTarget === 0 && this.spotMat.opacity < 0.004) this.spot.visible = false
    }

    // Focus fade: nodes and edges ease towards their target opacity.
    for (const v of this.visuals.values()) {
      if (Math.abs(v.mat.opacity - v.targetOpacity) > 0.002) {
        v.mat.opacity = lerp(v.mat.opacity, v.targetOpacity, k)
        if (v.ring) (v.ring.material as THREE.MeshBasicMaterial).opacity = 0.8 * v.mat.opacity
        if (v.label) v.label.element.style.opacity = String(v.mat.opacity < 0.5 ? 0 : 1)
      }
    }
    for (const lm of this.linkMats.values()) {
      if (lm.fxT0 !== undefined) {
        const age = t - lm.fxT0
        if (age < HOLD_S) lm.mat.opacity = EDGE_HOT
        else if (age < HOLD_S + SETTLE_S) lm.mat.opacity = EDGE_HOT + (EDGE_REST - EDGE_HOT) * easeOut((age - HOLD_S) / SETTLE_S)
        else lm.mat.opacity = EDGE_REST
      } else if (Math.abs(lm.mat.opacity - lm.targetOpacity) > 0.002) lm.mat.opacity = lerp(lm.mat.opacity, lm.targetOpacity, k)
    }

    // Node highlight timelines: attack to 1.6x, hold, settle to a subtle persistent outline.
    for (const [id, m] of this.marks) {
      const v = this.visuals.get(id)
      if (!v) continue
      if (!v.label && this.css2d && this.labelCount < MAX_LABELS) this.setLabel(id, m.color, m.text)
      const age = t - m.t0
      let scale: number
      let outline: number
      if (age < ATTACK_S) {
        const kk = easeOut(age / ATTACK_S)
        scale = 1 + (PEAK_SCALE - 1) * kk
        outline = 0.35 * kk
      } else if (age < HOLD_S) {
        scale = PEAK_SCALE
        outline = 0.35
      } else if (age < HOLD_S + SETTLE_S) {
        const kk = easeOut((age - HOLD_S) / SETTLE_S)
        scale = PEAK_SCALE + (REST_SCALE - PEAK_SCALE) * kk
        outline = 0.35 + (0.55 - 0.35) * kk
      } else {
        scale = REST_SCALE
        outline = 0.55
      }
      v.core.scale.setScalar(v.radius * scale)
      v.outline.scale.setScalar(v.radius * scale * 1.22)
      v.outline.visible = true
      v.outlineMat.opacity = outline
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
    for (const lm of this.linkMats.values()) lm.mat.dispose()
    this.linkMats.clear()
    try {
      this.graph._destructor()
    } catch {
      /* ignore */
    }
  }
}
