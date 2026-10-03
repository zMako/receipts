/**
 * The three.js exhibit: a 3d-force-graph of the merchant's evidence graph with agent avatars,
 * evidence streaks, highlights and bloom. Pure presentation: reads State, reacts to LiveEvents.
 */
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph'
import * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { AGENT_META, AGENT_NAMES, POPULATION_COLOR, type AgentName, type LiveEvent } from './contract'
import type { GNode, NodeType, State } from './state'

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
  agentColor?: string
}

interface NodeVisual {
  core: THREE.Mesh
  mat: THREE.MeshLambertMaterial
  halo: THREE.Mesh | null
  base: number
  emissive: number
  pulse: number
}

interface Avatar {
  name: AgentName
  group: THREE.Group
  core: THREE.Mesh
  glow: THREE.Sprite
  glowMat: THREE.SpriteMaterial
  coreMat: THREE.MeshBasicMaterial
  mode: 'idle' | 'orbit'
  index: number
  spin: number
}

interface Flash {
  line: THREE.Line
  mat: THREE.LineBasicMaterial
  a: string
  b: string
  ttl: number
  life: number
}

interface Streak {
  mesh: THREE.Mesh
  trail: THREE.Line
  from: THREE.Vector3
  target: string
  color: string
  t: number
  dur: number
  points: THREE.Vector3[]
  onArrive?: () => void
}

interface Burst {
  points: THREE.Points
  mat: THREE.PointsMaterial
  vel: Float32Array
  age: number
  life: number
}

const NODE_COLOR: Record<NodeType, string> = {
  customer: '#e8ecf6',
  order: '#7dd3fc',
  device: '#8b93a6',
  address: '#94a3b8',
  payment: '#9fb0c8',
  return: '#fdba74',
  dispute: '#f87171',
  evidence: '#ffffff',
}

const LINK_DIM = '#2a3246'
const LINK_CASE = '#5d6f94'

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

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.25, 'rgba(255,255,255,.55)')
  g.addColorStop(0.6, 'rgba(255,255,255,.12)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 128, 128)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function labelSprite(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 128
  const ctx = c.getContext('2d')!
  ctx.font = '600 56px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.shadowColor = 'rgba(0,0,0,.8)'
  ctx.shadowBlur = 12
  ctx.fillStyle = color
  ctx.fillText(text.toUpperCase(), 256, 64)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.9 })
  const s = new THREE.Sprite(mat)
  s.scale.set(28, 7, 1)
  return s
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

export class ExhibitScene {
  readonly graph: ForceGraph3DInstance<FNode, FLink>
  private readonly container: HTMLElement
  private readonly panelWidth: number
  private readonly fgNodes = new Map<string, FNode>()
  private readonly fgLinks = new Map<string, FLink>()
  private readonly visuals = new Map<string, NodeVisual>()
  private readonly linkAgentColor = new Map<string, string>()
  private readonly fx = new THREE.Group()
  private readonly avatars: Record<AgentName, Avatar>
  private readonly glowTex = glowTexture()
  private readonly geo: Record<string, THREE.BufferGeometry>
  private flashes: Flash[] = []
  private streaks: Streak[] = []
  private bursts: Burst[] = []
  private lastLit = new Set<string>()
  private caseOrderId: string | null = null
  private pendingFocus: string | null = null
  private settled = false
  private top = 150
  private t = 0
  private resumeRotateAt: number | null = null
  private rotateSpeed = 0.45
  private controls: OrbitControls
  private bloom: UnrealBloomPass
  private disposed = false
  private readonly onResize = () => this.resize()

  constructor(container: HTMLElement, opts: { panelWidth: number }) {
    this.container = container
    this.panelWidth = opts.panelWidth
    this.geo = {
      customer: new THREE.SphereGeometry(2.1, 18, 14),
      order: new THREE.SphereGeometry(2.7, 20, 16),
      device: new THREE.OctahedronGeometry(1.9, 0),
      cluster: new THREE.OctahedronGeometry(3.4, 1),
      address: new THREE.CylinderGeometry(2.5, 2.5, 0.45, 24),
      payment: new THREE.BoxGeometry(2.3, 2.3, 2.3),
      return: new THREE.TorusGeometry(2.6, 0.5, 10, 28),
      dispute: new THREE.TorusGeometry(3.1, 0.55, 10, 28),
      evidence: new THREE.TetrahedronGeometry(2.2, 0),
      halo: new THREE.SphereGeometry(5.6, 18, 14),
      agent: new THREE.SphereGeometry(3, 24, 18),
      streak: new THREE.SphereGeometry(1.5, 10, 8),
    }

    const graph = new ForceGraph3D(container, { controlType: 'orbit', rendererConfig: { antialias: true, alpha: false, powerPreference: 'high-performance' } }) as unknown as ForceGraph3DInstance<FNode, FLink>
    this.graph = graph
    graph
      .width(window.innerWidth)
      .height(window.innerHeight)
      .backgroundColor('#05060a')
      .showNavInfo(false)
      .nodeId('id')
      .nodeRelSize(3)
      .nodeLabel((n) => `<div style="font:13px system-ui;color:#fff;background:rgba(10,12,20,.9);padding:6px 9px;border-radius:6px;border:1px solid rgba(255,255,255,.12)"><b>${n.type}</b> · ${escapeHtml(n.label)}${n.population ? `<br><span style="color:${POPULATION_COLOR[n.population as keyof typeof POPULATION_COLOR] ?? '#aaa'}">${n.population}</span>` : ''}${n.flags?.length ? `<br><span style="color:#fca5a5">${n.flags.join(', ')}</span>` : ''}</div>`)
      .nodeThreeObject((n) => this.buildNode(n))
      .nodeThreeObjectExtend(false)
      .linkSource('source')
      .linkTarget('target')
      .linkWidth(0)
      .linkOpacity(0.32)
      .linkColor((l) => this.linkColorOf(l))
      .enableNodeDrag(false)
      .onNodeClick((n) => this.focusNode(n.id, 95))
      .d3AlphaDecay(0.028)
      .d3VelocityDecay(0.42)
      .warmupTicks(240)
      .cooldownTicks(0)
      .onEngineStop(() => this.onSettled())

    const charge = graph.d3Force('charge')
    if (charge && typeof charge.strength === 'function') charge.strength(-48)
    const link = graph.d3Force('link')
    if (link && typeof link.distance === 'function') link.distance((l: FLink) => (l.type === 'placed' ? 26 : 18))

    graph.lights([
      new THREE.AmbientLight(0xffffff, 0.55),
      (() => {
        const d = new THREE.DirectionalLight(0xffffff, 1.3)
        d.position.set(1, 1.4, 1)
        return d
      })(),
      (() => {
        const d = new THREE.DirectionalLight(0x7d8cff, 0.5)
        d.position.set(-1, -0.6, -1)
        return d
      })(),
    ])

    const scene = graph.scene()
    scene.add(this.fx)

    this.controls = graph.controls() as OrbitControls
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.autoRotate = true
    this.controls.autoRotateSpeed = this.rotateSpeed
    this.controls.maxDistance = 1400

    const composer = graph.postProcessingComposer()
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.05, 0.6, 0.55)
    composer.addPass(this.bloom)
    composer.addPass(new OutputPass())
    graph.renderer().toneMapping = THREE.ACESFilmicToneMapping
    graph.renderer().toneMappingExposure = 1.1

    this.avatars = {} as Record<AgentName, Avatar>
    AGENT_NAMES.forEach((name, i) => (this.avatars[name] = this.buildAvatar(name, i)))

    graph.cameraPosition({ x: 0, y: 80, z: 460 }, { x: 0, y: 0, z: 0 }, 0)
    this.applyViewOffset()
    window.addEventListener('resize', this.onResize)
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
        this.visuals.delete(id)
        changed = true
      }
    }
    const linkSeen = new Set<string>()
    for (const e of g.edges) {
      const key = `${e.source}>${e.target}:${e.type}`
      linkSeen.add(key)
      if (!this.fgLinks.has(key)) {
        this.fgLinks.set(key, { key, source: e.source, target: e.target, type: e.type, delta: e.delta, agentColor: this.linkAgentColor.get(key) })
        changed = true
      }
    }
    for (const key of [...this.fgLinks.keys()]) {
      if (!linkSeen.has(key)) {
        this.fgLinks.delete(key)
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
        const c = nb.length ? nb.reduce((a, o) => a.add(new THREE.Vector3(o.x, o.y, o.z)), new THREE.Vector3()).multiplyScalar(1 / nb.length) : new THREE.Vector3(0, this.top * 0.5, 0)
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
      this.computeTop()
      try {
        this.graph.zoomToFit(1200, 70)
      } catch {
        /* no nodes yet */
      }
    }
  }

  private computeTop() {
    try {
      const b = this.graph.getGraphBbox()
      if (b) this.top = b.y[1] + 36
    } catch {
      this.top = 150
    }
  }

  private linkColorOf(l: FLink): string {
    if (l.agentColor) return l.agentColor
    if (this.caseOrderId && (idOf(l.source) === this.caseOrderId || idOf(l.target) === this.caseOrderId)) return LINK_CASE
    return LINK_DIM
  }

  private refreshLinks() {
    this.graph.linkColor((l) => this.linkColorOf(l))
  }

  // ----- node visuals -------------------------------------------------------------------------

  private styleOf(n: FNode): { color: string; geo: THREE.BufferGeometry; emissive: number; pulse: number; scale: number } {
    const cluster = n.population === 'cluster'
    if (n.type === 'device' && cluster) return { color: POPULATION_COLOR.cluster, geo: this.geo.cluster, emissive: 0.55, pulse: 1, scale: n.delta ? 1.6 : 1 }
    if (n.type === 'order') {
      const color = POPULATION_COLOR[(n.population ?? 'human') as keyof typeof POPULATION_COLOR] ?? NODE_COLOR.order
      return { color, geo: this.geo.order, emissive: 0.32, pulse: 0, scale: 1 }
    }
    const geo = this.geo[n.type] ?? this.geo.device
    const emissive = n.type === 'customer' ? 0.18 : n.type === 'dispute' ? 0.35 : n.type === 'return' ? 0.28 : 0.08
    return { color: NODE_COLOR[n.type] ?? '#aaaaaa', geo, emissive, pulse: 0, scale: 1 }
  }

  private buildNode(n: FNode): THREE.Object3D {
    const st = this.styleOf(n)
    const mat = new THREE.MeshLambertMaterial({ color: st.color, emissive: st.color, emissiveIntensity: st.emissive })
    const core = new THREE.Mesh(st.geo, mat)
    core.scale.setScalar(st.scale)
    if (n.type === 'address') core.rotation.x = Math.PI / 2
    if (n.type === 'return' || n.type === 'dispute') core.rotation.x = Math.PI / 3
    const group = new THREE.Group()
    group.add(core)
    let halo: THREE.Mesh | null = null
    if (n.type === 'order' && n.flags && n.flags.length) {
      halo = new THREE.Mesh(this.geo.halo, new THREE.MeshBasicMaterial({ color: '#ef4444', transparent: true, opacity: 0.11, depthWrite: false, blending: THREE.AdditiveBlending }))
      group.add(halo)
    }
    this.visuals.set(n.id, { core, mat, halo, base: st.scale, emissive: st.emissive, pulse: st.pulse })
    return group
  }

  private restyle(n: FNode) {
    const v = this.visuals.get(n.id)
    if (!v) return
    const st = this.styleOf(n)
    v.mat.color.set(st.color)
    v.mat.emissive.set(st.color)
    v.emissive = st.emissive
    v.base = st.scale
    v.pulse = st.pulse
    if (v.core.geometry !== st.geo) v.core.geometry = st.geo
    if (n.type === 'order' && n.flags?.length && !v.halo) {
      v.halo = new THREE.Mesh(this.geo.halo, new THREE.MeshBasicMaterial({ color: '#ef4444', transparent: true, opacity: 0.11, depthWrite: false, blending: THREE.AdditiveBlending }))
      v.core.parent?.add(v.halo)
    }
  }

  private nodePos(id: string, out = new THREE.Vector3()): THREE.Vector3 | null {
    const n = this.fgNodes.get(id)
    if (!n || n.x === undefined || n.y === undefined || n.z === undefined || Number.isNaN(n.x)) return null
    return out.set(n.x, n.y, n.z)
  }

  // ----- agents -------------------------------------------------------------------------------

  private buildAvatar(name: AgentName, index: number): Avatar {
    const color = AGENT_META[name].color
    const coreMat = new THREE.MeshBasicMaterial({ color })
    const core = new THREE.Mesh(this.geo.agent, coreMat)
    const glowMat = new THREE.SpriteMaterial({ map: this.glowTex, color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })
    const glow = new THREE.Sprite(glowMat)
    glow.scale.setScalar(26)
    const label = labelSprite(AGENT_META[name].title, color)
    label.position.y = -8
    const group = new THREE.Group()
    group.add(glow, core, label)
    group.position.set((index - 2) * 30, this.top, 0)
    this.fx.add(group)
    return { name, group, core, glow, glowMat, coreMat, mode: 'idle', index, spin: index * 1.3 }
  }

  private avatarTarget(a: Avatar, state: State, out: THREE.Vector3): THREE.Vector3 {
    const center = this.caseOrderId ? this.nodePos(this.caseOrderId) : null
    if (a.mode === 'orbit' && center) {
      const r = 24 + a.index * 2.5
      const ang = this.t * 0.75 + (a.index * Math.PI * 2) / 5
      const status = state.agents[a.name]?.status
      const lift = status === 'done' ? 14 : 0
      return out.set(center.x + Math.cos(ang) * r, center.y + Math.sin(this.t * 0.9 + a.index) * 7 + lift, center.z + Math.sin(ang) * r)
    }
    return out.set((a.index - 2) * 30, this.top + Math.sin(this.t * 1.1 + a.index) * 3, 0)
  }

  // ----- effects ------------------------------------------------------------------------------

  private spawnBurst(pos: THREE.Vector3, color: string, count = 40, speed = 30, life = 0.9, size = 2.4) {
    const positions = new Float32Array(count * 3)
    const vel = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      positions[i * 3] = pos.x
      positions[i * 3 + 1] = pos.y
      positions[i * 3 + 2] = pos.z
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.35 + Math.random() * 0.65))
      vel[i * 3] = v.x
      vel[i * 3 + 1] = v.y
      vel[i * 3 + 2] = v.z
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const mat = new THREE.PointsMaterial({ color, size, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true })
    const points = new THREE.Points(geo, mat)
    this.fx.add(points)
    this.bursts.push({ points, mat, vel, age: 0, life })
  }

  private spawnFlash(a: string, b: string, color: string, life = 2.4) {
    const pa = this.nodePos(a)
    const pb = this.nodePos(b)
    if (!pa || !pb) return
    const geo = new THREE.BufferGeometry().setFromPoints([pa, pb])
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
    const line = new THREE.Line(geo, mat)
    this.fx.add(line)
    this.flashes.push({ line, mat, a, b, ttl: life, life })
  }

  private spawnStreak(from: THREE.Vector3, target: string, color: string, onArrive?: () => void) {
    if (!this.nodePos(target)) return
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false })
    const mesh = new THREE.Mesh(this.geo.streak, mat)
    mesh.position.copy(from)
    const points = Array.from({ length: 14 }, () => from.clone())
    const trail = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }))
    this.fx.add(mesh, trail)
    this.streaks.push({ mesh, trail, from: from.clone(), target, color, t: 0, dur: 0.7, points, onArrive })
  }

  /** Flash every link that touches `ids` (and the case node) in a colour. */
  private flashAround(ids: string[], color: string) {
    const set = new Set(ids)
    if (this.caseOrderId) set.add(this.caseOrderId)
    for (const l of this.fgLinks.values()) {
      const s = idOf(l.source)
      const t = idOf(l.target)
      if ((set.has(s) && set.has(t)) || ((set.has(s) || set.has(t)) && (s === this.caseOrderId || t === this.caseOrderId) && ids.includes(s === this.caseOrderId ? t : s))) this.spawnFlash(s, t, color)
    }
  }

  // ----- events -------------------------------------------------------------------------------

  onEvent(event: LiveEvent, state: State): void {
    if (this.disposed || !event || typeof event !== 'object') return
    try {
      switch (event.type) {
        case 'case.opened': {
          this.caseOrderId = event.order_id
          this.linkAgentColor.clear()
          this.clearFx()
          for (const a of AGENT_NAMES) this.avatars[a].mode = 'idle'
          this.refreshLinks()
          this.rotateSpeed = 0.18
          this.focusNode(event.order_id, 120)
          break
        }
        case 'agent.joined': {
          const a = this.avatars[event.agent]
          if (!a) break
          a.mode = 'orbit'
          this.spawnBurst(a.group.position.clone(), AGENT_META[event.agent].color, 24, 18, 0.7, 2)
          break
        }
        case 'agent.status': {
          const a = this.avatars[event.agent]
          if (!a) break
          if (event.status === 'tool') this.spawnBurst(a.group.position.clone(), AGENT_META[event.agent].color, 44, 34, 0.9)
          if (event.status === 'error') this.spawnBurst(a.group.position.clone(), '#f87171', 30, 24, 0.8)
          break
        }
        case 'agent.message': {
          const a = this.avatars[event.agent]
          if (!a) break
          this.spawnBurst(a.group.position.clone(), AGENT_META[event.agent].color, 14, 10, 0.6, 1.8)
          break
        }
        case 'evidence.attached': {
          const ev = event.evidence
          if (!ev) break
          const color = AGENT_META[event.agent]?.color ?? '#ffffff'
          for (const e of ev.graph?.edges ?? []) this.linkAgentColor.set(`${e.source}>${e.target}:${e.type}`, color)
          const a = this.avatars[event.agent]
          const from = a ? a.group.position.clone() : new THREE.Vector3(0, this.top, 0)
          const ids = (ev.node_ids ?? []).filter((id) => typeof id === 'string')
          // New delta nodes have no position until setGraph runs; streak to them on the next frame.
          window.setTimeout(() => {
            if (this.disposed) return
            let first = true
            for (const id of ids) {
              const arrive = first ? () => this.flashAround(ids, color) : undefined
              first = false
              this.spawnStreak(from, id, color, arrive)
            }
            if (!ids.length) this.flashAround([], color)
            this.refreshLinks()
          }, 0)
          break
        }
        case 'verdict': {
          const p = this.caseOrderId ? this.nodePos(this.caseOrderId) : null
          if (p) {
            this.spawnBurst(p, AGENT_META.critic.color, 90, 46, 1.4, 3)
            const ids = new Set<string>()
            for (const e of state.evidence) if (event.evidence_ids.includes(e.id)) for (const id of e.node_ids ?? []) ids.add(id)
            this.flashAround([...ids], event.tier === 'decline' ? '#f87171' : AGENT_META.critic.color)
          }
          break
        }
        case 'dispute.routing': {
          if (this.fgNodes.has(event.dispute_id) && this.caseOrderId) this.spawnFlash(this.caseOrderId, event.dispute_id, '#f87171', 3)
          const p = this.nodePos(event.dispute_id)
          if (p) this.spawnBurst(p, '#f87171', 40, 26, 1)
          break
        }
        case 'stripe.evidence_staged': {
          const p = this.nodePos(event.dispute_id) ?? (this.caseOrderId ? this.nodePos(this.caseOrderId) : null)
          if (p) this.spawnBurst(p, '#ffffff', 60, 30, 1.2, 2.2)
          break
        }
        case 'case.closed': {
          this.rotateSpeed = 0.3
          break
        }
        case 'reset': {
          this.caseOrderId = null
          this.pendingFocus = null
          this.linkAgentColor.clear()
          this.clearFx()
          for (const a of AGENT_NAMES) this.avatars[a].mode = 'idle'
          this.refreshLinks()
          this.rotateSpeed = 0.45
          break
        }
        default:
          break
      }
    } catch (err) {
      console.warn('[scene] event handling failed', err)
    }
  }

  private clearFx() {
    for (const f of this.flashes) this.dispose(f.line)
    for (const s of this.streaks) {
      this.dispose(s.mesh)
      this.dispose(s.trail)
    }
    for (const b of this.bursts) this.dispose(b.points)
    this.flashes = []
    this.streaks = []
    this.bursts = []
  }

  private dispose(obj: THREE.Object3D) {
    this.fx.remove(obj)
    const o = obj as THREE.Mesh
    const shared = Object.values(this.geo).includes(o.geometry)
    if (!shared) o.geometry?.dispose?.()
    const m = o.material as THREE.Material | undefined
    m?.dispose?.()
  }

  // ----- camera -------------------------------------------------------------------------------

  focusNode(id: string, distance = 110): void {
    const p = this.nodePos(id)
    if (!p) {
      this.pendingFocus = id
      return
    }
    this.pendingFocus = null
    const cam = this.graph.camera()
    const dir = cam.position.clone().sub(p)
    if (dir.length() < 1) dir.set(0.4, 0.3, 1)
    dir.normalize()
    dir.y = Math.max(dir.y, 0.22)
    dir.normalize()
    const pos = p.clone().add(dir.multiplyScalar(distance))
    this.controls.autoRotate = false
    this.graph.cameraPosition({ x: pos.x, y: pos.y, z: pos.z }, { x: p.x, y: p.y, z: p.z }, 1800)
    this.resumeRotateAt = this.t + 2.1
  }

  focusOverview(): void {
    this.controls.autoRotate = false
    try {
      this.graph.zoomToFit(2400, 70)
    } catch {
      this.graph.cameraPosition({ x: 0, y: 80, z: 460 }, { x: 0, y: 0, z: 0 }, 2400)
    }
    this.resumeRotateAt = this.t + 2.6
  }

  private applyViewOffset() {
    const cam = this.graph.camera() as THREE.PerspectiveCamera
    if (!cam || !('setViewOffset' in cam)) return
    const w = window.innerWidth
    const h = window.innerHeight
    if (w > 900) cam.setViewOffset(w, h, this.panelWidth / 2, 0, w, h)
    else cam.clearViewOffset()
    cam.updateProjectionMatrix()
  }

  resize(): void {
    if (this.disposed) return
    this.graph.width(window.innerWidth).height(window.innerHeight)
    this.bloom.setSize(window.innerWidth, window.innerHeight)
    this.applyViewOffset()
  }

  // ----- per-frame ----------------------------------------------------------------------------

  frame(state: State, dt: number): void {
    if (this.disposed) return
    dt = Math.min(0.1, Math.max(0, dt))
    this.t += dt
    const t = this.t

    if (this.resumeRotateAt !== null && t >= this.resumeRotateAt) {
      this.resumeRotateAt = null
      this.controls.autoRotate = true
    }
    this.controls.autoRotateSpeed = this.rotateSpeed

    if (this.pendingFocus && this.nodePos(this.pendingFocus)) this.focusNode(this.pendingFocus, 120)

    // Highlights: reset what went dark, then apply current intensities.
    const lit = state.highlights
    for (const id of this.lastLit) {
      if (lit[id] === undefined) {
        const v = this.visuals.get(id)
        if (v) {
          v.core.scale.setScalar(v.base)
          v.mat.emissiveIntensity = v.emissive
          if (v.halo) (v.halo.material as THREE.MeshBasicMaterial).opacity = 0.11
        }
      }
    }
    this.lastLit = new Set(Object.keys(lit))
    for (const id of this.lastLit) {
      const v = this.visuals.get(id)
      if (!v) continue
      const k = Math.max(0, Math.min(1, lit[id]))
      v.core.scale.setScalar(v.base * (1 + 0.95 * k))
      v.mat.emissiveIntensity = v.emissive + 2.4 * k
      if (v.halo) (v.halo.material as THREE.MeshBasicMaterial).opacity = 0.11 + 0.4 * k
    }
    // Shared sandbox devices breathe.
    for (const [id, v] of this.visuals) {
      if (!v.pulse) continue
      const k = lit[id] ?? 0
      v.core.scale.setScalar(v.base * (1 + 0.95 * k) * (1 + 0.14 * Math.sin(t * 2.6 + hash(id) % 7)))
      v.core.rotation.y = t * 0.6
    }

    // Agents.
    const target = new THREE.Vector3()
    const lerp = 1 - Math.exp(-dt * 2.4)
    for (const name of AGENT_NAMES) {
      const a = this.avatars[name]
      const st = state.agents[name]
      this.avatarTarget(a, state, target)
      a.group.position.lerp(target, lerp)
      const status = st?.status ?? 'idle'
      const active = st?.joined ?? false
      const pulse = status === 'thinking' || status === 'tool' ? 0.5 + 0.5 * Math.sin(t * 9 + a.spin) : 0
      const energy = !active ? 0.45 : status === 'done' ? 0.7 : 1
      a.glowMat.opacity = (0.5 + 0.45 * pulse) * energy
      a.glow.scale.setScalar(24 + 10 * pulse + (status === 'posting' ? 6 : 0))
      a.core.scale.setScalar(energy * (1 + 0.25 * pulse))
      a.coreMat.color.set(status === 'error' ? '#f87171' : AGENT_META[name].color)
      a.group.rotation.y = t * 0.4
      a.group.visible = true
    }

    // Streaks.
    const keepStreaks: Streak[] = []
    for (const s of this.streaks) {
      s.t += dt
      const to = this.nodePos(s.target)
      if (!to) {
        this.dispose(s.mesh)
        this.dispose(s.trail)
        continue
      }
      const k = ease(Math.min(1, s.t / s.dur))
      const mid = s.from.clone().lerp(to, 0.5)
      mid.y += 18
      const p = new THREE.Vector3().copy(s.from).multiplyScalar((1 - k) * (1 - k)).add(mid.clone().multiplyScalar(2 * (1 - k) * k)).add(to.clone().multiplyScalar(k * k))
      s.mesh.position.copy(p)
      s.points.pop()
      s.points.unshift(p.clone())
      s.trail.geometry.setFromPoints(s.points)
      if (s.t >= s.dur) {
        this.spawnBurst(to, s.color, 26, 14, 0.7, 2)
        s.onArrive?.()
        this.dispose(s.mesh)
        this.dispose(s.trail)
      } else keepStreaks.push(s)
    }
    this.streaks = keepStreaks

    // Flash lines follow their nodes and fade.
    const keepFlashes: Flash[] = []
    for (const f of this.flashes) {
      f.ttl -= dt
      const pa = this.nodePos(f.a)
      const pb = this.nodePos(f.b)
      if (f.ttl <= 0 || !pa || !pb) {
        this.dispose(f.line)
        continue
      }
      f.line.geometry.setFromPoints([pa, pb])
      f.mat.opacity = 0.95 * (f.ttl / f.life)
      keepFlashes.push(f)
    }
    this.flashes = keepFlashes

    // Particle bursts.
    const keepBursts: Burst[] = []
    for (const b of this.bursts) {
      b.age += dt
      if (b.age >= b.life) {
        this.dispose(b.points)
        continue
      }
      const pos = b.points.geometry.getAttribute('position') as THREE.BufferAttribute
      const arr = pos.array as Float32Array
      const damp = Math.max(0, 1 - 2.6 * dt)
      for (let i = 0; i < arr.length; i++) {
        arr[i] += b.vel[i] * dt
        b.vel[i] *= damp
      }
      pos.needsUpdate = true
      const k = b.age / b.life
      b.mat.opacity = 1 - k
      b.mat.size = b.mat.size * (1 + 0.6 * dt)
      keepBursts.push(b)
    }
    this.bursts = keepBursts
  }

  get isSettled(): boolean {
    return this.settled
  }

  destroy(): void {
    this.disposed = true
    window.removeEventListener('resize', this.onResize)
    this.clearFx()
    try {
      this.graph._destructor()
    } catch {
      /* ignore */
    }
  }
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}
