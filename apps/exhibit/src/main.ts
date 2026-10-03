import * as THREE from 'three'

const app = document.getElementById('app')!
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
app.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000)
camera.position.z = 8

const geo = new THREE.IcosahedronGeometry(1, 1)
const mat = new THREE.MeshStandardMaterial({ color: 0x6ee7ff, wireframe: true })
const mesh = new THREE.Mesh(geo, mat)
scene.add(mesh)
scene.add(new THREE.AmbientLight(0xffffff, 0.6))
const light = new THREE.PointLight(0xffffff, 2)
light.position.set(5, 5, 5)
scene.add(light)

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

function tick() {
  mesh.rotation.y += 0.004
  renderer.render(scene, camera)
  requestAnimationFrame(tick)
}
tick()
