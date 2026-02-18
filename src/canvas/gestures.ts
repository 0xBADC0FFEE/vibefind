import { getMinScale, type Viewport } from './viewport.ts'

const PAN_DECEL = 0.95
const MAX_SCALE = 3

export interface TapIntent {
  source: 'touch' | 'mouse' | 'aux'
  button: 0 | 1
  metaKey: boolean
  ctrlKey: boolean
}

export interface GestureState {
  panning: boolean
  pinching: boolean
  active: boolean
  lastX: number
  lastY: number
  velocityX: number
  velocityY: number
  pinchDist: number
  pinchCenterX: number
  pinchCenterY: number
  animId: number
  disabled: boolean
  trackpadPanEnabled: boolean
}

export function createGestureState(): GestureState {
  return {
    panning: false, pinching: false, active: false,
    lastX: 0, lastY: 0,
    velocityX: 0, velocityY: 0,
    pinchDist: 0, pinchCenterX: 0, pinchCenterY: 0,
    animId: 0,
    disabled: false,
    trackpadPanEnabled: false,
  }
}

function dist(t: TouchList): number {
  const dx = t[0].clientX - t[1].clientX
  const dy = t[0].clientY - t[1].clientY
  return Math.sqrt(dx * dx + dy * dy)
}

function center(t: TouchList): [number, number] {
  return [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2]
}

export function setupGestures(
  el: HTMLCanvasElement,
  vp: Viewport,
  gs: GestureState,
  onUpdate: (immediate?: boolean) => void,
  onTap?: (sx: number, sy: number, tap: TapIntent) => void,
) {
  let touchStartX = 0, touchStartY = 0, touchStartTime = 0
  let wasPinching = false

  el.addEventListener('touchstart', (e) => {
    e.preventDefault()
    if (gs.disabled) return
    cancelAnimationFrame(gs.animId)
    gs.velocityX = gs.velocityY = 0

    if (e.touches.length === 1) {
      gs.panning = true
      gs.active = true
      gs.lastX = e.touches[0].clientX
      gs.lastY = e.touches[0].clientY
      touchStartX = gs.lastX
      touchStartY = gs.lastY
      touchStartTime = performance.now()
      wasPinching = false
    } else if (e.touches.length === 2) {
      gs.panning = false
      gs.pinching = true
      gs.active = true
      gs.pinchDist = dist(e.touches)
      ;[gs.pinchCenterX, gs.pinchCenterY] = center(e.touches)
      wasPinching = true
    }
  }, { passive: false })

  el.addEventListener('touchmove', (e) => {
    e.preventDefault()
    if (gs.disabled) return

    if (gs.pinching && e.touches.length === 2) {
      const newDist = dist(e.touches)
      const [cx, cy] = center(e.touches)
      const ratio = newDist / gs.pinchDist

      const newScale = Math.min(MAX_SCALE, Math.max(getMinScale(vp), vp.scale * ratio))
      const scaleChange = newScale / vp.scale

      vp.offsetX = cx - (cx - vp.offsetX) * scaleChange + (cx - gs.pinchCenterX)
      vp.offsetY = cy - (cy - vp.offsetY) * scaleChange + (cy - gs.pinchCenterY)
      vp.scale = newScale

      gs.pinchDist = newDist
      ;[gs.pinchCenterX, gs.pinchCenterY] = [cx, cy]
      onUpdate()
    } else if (gs.panning && e.touches.length === 1) {
      const x = e.touches[0].clientX
      const y = e.touches[0].clientY
      const dx = x - gs.lastX
      const dy = y - gs.lastY

      vp.offsetX += dx
      vp.offsetY += dy
      gs.velocityX = gs.velocityX * 0.6 + dx * 0.4
      gs.velocityY = gs.velocityY * 0.6 + dy * 0.4
      gs.lastX = x
      gs.lastY = y
      onUpdate()
    }
  }, { passive: false })

  el.addEventListener('touchend', (e) => {
    if (e.touches.length === 0) {
      if (onTap && !wasPinching) {
        const dx = gs.lastX - touchStartX
        const dy = gs.lastY - touchStartY
        const dt = performance.now() - touchStartTime
        if (dx * dx + dy * dy < 100 && dt < 300) {
          onTap(gs.lastX, gs.lastY, {
            source: 'touch',
            button: 0,
            metaKey: false,
            ctrlKey: false,
          })
        }
      }
      gs.panning = false
      gs.pinching = false
      gs.active = false
      startInertia(vp, gs, onUpdate)
    } else if (e.touches.length === 1) {
      gs.pinching = false
      gs.panning = true
      gs.lastX = e.touches[0].clientX
      gs.lastY = e.touches[0].clientY
    }
  })

  // Mouse support for desktop
  let mouseDown = false
  let mouseStartX = 0, mouseStartY = 0
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    if (gs.disabled) return
    mouseDown = true
    gs.active = true
    cancelAnimationFrame(gs.animId)
    gs.velocityX = gs.velocityY = 0
    gs.lastX = e.clientX
    gs.lastY = e.clientY
    mouseStartX = e.clientX
    mouseStartY = e.clientY
  })

  el.addEventListener('mousemove', (e) => {
    if (!mouseDown) return
    const dx = e.clientX - gs.lastX
    const dy = e.clientY - gs.lastY
    vp.offsetX += dx
    vp.offsetY += dy
    gs.velocityX = gs.velocityX * 0.6 + dx * 0.4
    gs.velocityY = gs.velocityY * 0.6 + dy * 0.4
    gs.lastX = e.clientX
    gs.lastY = e.clientY
    onUpdate()
  })

  el.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return
    if (!mouseDown) return
    if (onTap) {
      const dx = e.clientX - mouseStartX
      const dy = e.clientY - mouseStartY
      if (dx * dx + dy * dy < 25) {
        onTap(e.clientX, e.clientY, {
          source: 'mouse',
          button: 0,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
        })
      }
    }
    mouseDown = false
    gs.active = false
    startInertia(vp, gs, onUpdate)
  })

  el.addEventListener('mouseleave', () => {
    if (mouseDown) {
      mouseDown = false
      gs.active = false
      startInertia(vp, gs, onUpdate)
    }
  })

  el.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return
    e.preventDefault()
    if (gs.disabled || !onTap) return
    onTap(e.clientX, e.clientY, {
      source: 'aux',
      button: 1,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
    })
  })

  el.addEventListener('wheel', (e) => {
    e.preventDefault()
    if (gs.disabled) return
    if (gs.trackpadPanEnabled && !e.ctrlKey && !e.metaKey) {
      vp.offsetX -= e.deltaX
      vp.offsetY -= e.deltaY
      gs.velocityX = -e.deltaX
      gs.velocityY = -e.deltaY
      onUpdate()
      return
    }
    const zoomFactor = e.deltaY > 0 ? 0.95 : 1.05
    const newScale = Math.min(MAX_SCALE, Math.max(getMinScale(vp), vp.scale * zoomFactor))
    const scaleChange = newScale / vp.scale

    vp.offsetX = e.clientX - (e.clientX - vp.offsetX) * scaleChange
    vp.offsetY = e.clientY - (e.clientY - vp.offsetY) * scaleChange
    vp.scale = newScale
    onUpdate()
  }, { passive: false })
}

function startInertia(vp: Viewport, gs: GestureState, onUpdate: (immediate?: boolean) => void) {
  function tick() {
    gs.velocityX *= PAN_DECEL
    gs.velocityY *= PAN_DECEL
    if (Math.abs(gs.velocityX) < 0.5 && Math.abs(gs.velocityY) < 0.5) {
      onUpdate()
      return
    }
    vp.offsetX += gs.velocityX
    vp.offsetY += gs.velocityY
    onUpdate(true)
    gs.animId = requestAnimationFrame(tick)
  }
  gs.animId = requestAnimationFrame(tick)
}
