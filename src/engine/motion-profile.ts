export interface MotionDiversityMetrics {
  speed: number
  t: number
  noiseFactor: number
  randomChance: number
}

export function calcMotionDiversityMetrics(
  velocityX: number,
  velocityY: number,
): MotionDiversityMetrics {
  const speed = Math.hypot(velocityX, velocityY)
  const t = Math.min(speed / 25, 1)
  const noiseFactor = 0.08 + t * 0.32
  const randomChance = 0.05 + t * 0.25
  return { speed, t, noiseFactor, randomChance }
}
