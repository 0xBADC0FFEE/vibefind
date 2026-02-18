import test from 'node:test'
import assert from 'node:assert/strict'
import { calcMotionDiversityMetrics } from './motion-profile.ts'

function assertClose(actual: number, expected: number, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${actual} ~= ${expected}`)
}

test('speed=0 maps to min noise/random values', () => {
  const m = calcMotionDiversityMetrics(0, 0)
  assert.equal(m.speed, 0)
  assert.equal(m.t, 0)
  assertClose(m.noiseFactor, 0.08)
  assertClose(m.randomChance, 0.05)
})

test('speed>=25 clamps t to 1 and maxes noise/random values', () => {
  const m = calcMotionDiversityMetrics(25, 0)
  assert.equal(m.speed, 25)
  assert.equal(m.t, 1)
  assertClose(m.noiseFactor, 0.40)
  assertClose(m.randomChance, 0.30)
})

test('intermediate speed uses linear interpolation', () => {
  const m = calcMotionDiversityMetrics(12.5, 0)
  assert.equal(m.speed, 12.5)
  assertClose(m.t, 0.5)
  assertClose(m.noiseFactor, 0.24)
  assertClose(m.randomChance, 0.175)
})
