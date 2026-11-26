import { describe, expect, it } from '@jest/globals'
import { readLockInputs } from '../../src/inputs.js'
import {
  allocateDeadline,
  buildAcquireBody,
  buildLockRequestJson,
  describeRequest
} from '../../src/request.js'

const ENV = {
  GITHUB_WORKFLOW: 'flash',
  GITHUB_RUN_NUMBER: '42',
  GITHUB_JOB: 'build',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'octo/repo',
  GITHUB_RUN_ID: '9001'
}
const DEFAULT_REASON =
  'flash #42 (build) https://github.com/octo/repo/actions/runs/9001'
const CONNECTION = {
  'server-url': 'https://jenkins.example.com',
  username: 'robot',
  token: 't0ken'
}

function jsonFor(inputs: Record<string, string>): Record<string, unknown> {
  const get = (name: string): string =>
    ({ ...CONNECTION, ...inputs })[name] ?? ''
  return buildLockRequestJson(readLockInputs(get, ENV).request)
}

/** Fields every request carries (Jenkins puts them unconditionally). */
const ALWAYS = {
  inversePrecedence: false,
  resourceSelectStrategy: 'SEQUENTIAL',
  skipIfLocked: false,
  timeoutUnit: 'MINUTES',
  reason: DEFAULT_REASON
}

describe('buildLockRequestJson: inputs -> lockRequest', () => {
  it.each<[string, Record<string, string>, Record<string, unknown>]>([
    // --- selectors
    ['resource only', { resource: 'r1' }, { group: 'common', resource: 'r1' }],
    [
      'resource is trimmed',
      { resource: '  r1 ' },
      { group: 'common', resource: 'r1' }
    ],
    [
      'blank resource is absent',
      { resource: '   ', label: 'plc' },
      { group: 'common', label: 'plc' }
    ],
    ['label only', { label: 'plc' }, { group: 'common', label: 'plc' }],
    [
      'resource and label both go through (server rejects)',
      { resource: 'r1', label: 'plc' },
      { group: 'common', resource: 'r1', label: 'plc' }
    ],
    ['group only', { group: 'lab' }, { group: 'lab' }],
    [
      'group with label',
      { group: ' lab ', label: 'plc' },
      { group: 'lab', label: 'plc' }
    ],
    [
      'empty group with label -> common',
      { group: '', label: 'plc' },
      { group: 'common', label: 'plc' }
    ],
    [
      'nothing at all: no group (server decides allowEmptyOrNullValues)',
      {},
      {}
    ],
    // --- quantity
    [
      'quantity empty',
      { label: 'plc', quantity: '' },
      { group: 'common', label: 'plc' }
    ],
    [
      'quantity 0',
      { label: 'plc', quantity: '0' },
      { group: 'common', label: 'plc' }
    ],
    [
      'quantity -1',
      { label: 'plc', quantity: '-1' },
      { group: 'common', label: 'plc' }
    ],
    [
      'quantity 2',
      { label: 'plc', quantity: '2' },
      { group: 'common', label: 'plc', quantity: 2 }
    ],
    [
      'quantity with spaces',
      { label: 'plc', quantity: ' 3 ' },
      { group: 'common', label: 'plc', quantity: 3 }
    ],
    // --- variable
    [
      'variable empty',
      { resource: 'r1', variable: '' },
      { group: 'common', resource: 'r1' }
    ],
    [
      'variable blank',
      { resource: 'r1', variable: '   ' },
      { group: 'common', resource: 'r1' }
    ],
    [
      'variable trimmed',
      { resource: 'r1', variable: ' PLC ' },
      { group: 'common', resource: 'r1', variable: 'PLC' }
    ],
    // --- booleans and enums
    [
      'inverse-precedence true',
      { resource: 'r1', 'inverse-precedence': 'true' },
      { group: 'common', resource: 'r1', inversePrecedence: true }
    ],
    [
      'inverse-precedence FALSE',
      { resource: 'r1', 'inverse-precedence': 'FALSE' },
      { group: 'common', resource: 'r1' }
    ],
    [
      'skip-if-locked True',
      { resource: 'r1', 'skip-if-locked': 'True' },
      { group: 'common', resource: 'r1', skipIfLocked: true }
    ],
    [
      'strategy random (sent upper-cased)',
      { label: 'plc', 'resource-select-strategy': 'random' },
      { group: 'common', label: 'plc', resourceSelectStrategy: 'RANDOM' }
    ],
    [
      'strategy empty',
      { label: 'plc', 'resource-select-strategy': '' },
      { group: 'common', label: 'plc' }
    ],
    // --- priority (differs from Jenkins for negative values, docs/design.md §10)
    [
      'priority empty',
      { resource: 'r1', priority: '' },
      { group: 'common', resource: 'r1' }
    ],
    [
      'priority 0',
      { resource: 'r1', priority: '0' },
      { group: 'common', resource: 'r1' }
    ],
    [
      'priority 5',
      { resource: 'r1', priority: '5' },
      { group: 'common', resource: 'r1', priority: 5 }
    ],
    [
      'priority -1 is sent',
      { resource: 'r1', priority: '-1' },
      { group: 'common', resource: 'r1', priority: -1 }
    ],
    // --- timeout
    [
      'timeout empty',
      { resource: 'r1', 'timeout-for-allocate-resource': '' },
      { group: 'common', resource: 'r1' }
    ],
    [
      'timeout 0',
      { resource: 'r1', 'timeout-for-allocate-resource': '0' },
      { group: 'common', resource: 'r1' }
    ],
    [
      'timeout -5',
      { resource: 'r1', 'timeout-for-allocate-resource': '-5' },
      { group: 'common', resource: 'r1' }
    ],
    [
      'timeout 30',
      { resource: 'r1', 'timeout-for-allocate-resource': '30' },
      { group: 'common', resource: 'r1', timeoutForAllocateResource: 30 }
    ],
    [
      'timeout-unit empty',
      { resource: 'r1', 'timeout-unit': '' },
      { group: 'common', resource: 'r1' }
    ],
    [
      'timeout-unit seconds',
      { resource: 'r1', 'timeout-unit': 'seconds' },
      { group: 'common', resource: 'r1', timeoutUnit: 'SECONDS' }
    ],
    // --- reason
    [
      'reason empty -> run reference',
      { resource: 'r1', reason: '' },
      { group: 'common', resource: 'r1' }
    ],
    [
      'reason blank -> run reference',
      { resource: 'r1', reason: '  ' },
      { group: 'common', resource: 'r1' }
    ],
    [
      'reason given',
      { resource: 'r1', reason: ' nightly flash ' },
      { group: 'common', resource: 'r1', reason: 'nightly flash' }
    ],
    // --- extra
    [
      'extra empty string',
      { resource: 'r1', extra: '' },
      { group: 'common', resource: 'r1' }
    ],
    [
      'extra []',
      { resource: 'r1', extra: '[]' },
      { group: 'common', resource: 'r1' }
    ],
    ['extra [] alone: no group', { extra: '[]' }, {}],
    ['extra null alone', { extra: 'null' }, {}],
    [
      'extra YAML list',
      {
        resource: 'r1',
        extra:
          '- resource: r4\n- label: gpu\n  quantity: 2\n- label: x\n  quantity: 0\n- group: lab2'
      },
      {
        group: 'common',
        resource: 'r1',
        extra: [
          { resource: 'r4' },
          { label: 'gpu', quantity: 2 },
          { label: 'x' },
          { group: 'lab2' }
        ]
      }
    ],
    [
      'extra JSON list',
      {
        label: 'plc',
        extra: '[{"resource":"r4"},{"label":"gpu","quantity":"2"}]'
      },
      {
        group: 'common',
        label: 'plc',
        extra: [{ resource: 'r4' }, { label: 'gpu', quantity: 2 }]
      }
    ],
    [
      'extra only (no main selector) still sends the group',
      { extra: '- resource: r4' },
      { group: 'common', extra: [{ resource: 'r4' }] }
    ],
    [
      'extra quantity -1 is dropped',
      { extra: '- label: gpu\n  quantity: -1' },
      { group: 'common', extra: [{ label: 'gpu' }] }
    ],
    [
      'extra blank strings are dropped',
      { extra: '- resource: "  "\n  label: gpu' },
      { group: 'common', extra: [{ label: 'gpu' }] }
    ],
    [
      'extra keeps the main group out of entries',
      { group: 'lab', extra: '- label: gpu' },
      { group: 'lab', extra: [{ label: 'gpu' }] }
    ]
  ])('%s', (_name, inputs, expected) => {
    expect(jsonFor(inputs)).toEqual({ ...ALWAYS, ...expected })
  })

  it('keeps the key order of the Jenkins client', () => {
    const json = jsonFor({
      group: 'lab',
      resource: 'r1',
      label: 'plc',
      quantity: '2',
      variable: 'PLC',
      'inverse-precedence': 'true',
      'resource-select-strategy': 'RANDOM',
      'skip-if-locked': 'true',
      extra: '- group: g\n  resource: r\n  label: l\n  quantity: 1',
      priority: '3',
      'timeout-for-allocate-resource': '5',
      'timeout-unit': 'SECONDS',
      reason: 'why'
    })
    expect(Object.keys(json)).toEqual([
      'group',
      'resource',
      'label',
      'quantity',
      'variable',
      'inversePrecedence',
      'resourceSelectStrategy',
      'skipIfLocked',
      'extra',
      'priority',
      'timeoutForAllocateResource',
      'timeoutUnit',
      'reason'
    ])
    expect(Object.keys((json.extra as object[])[0] as object)).toEqual([
      'group',
      'resource',
      'label',
      'quantity'
    ])
  })
})

// ---------------------------------------------------------------------------
// Reference model: LockStep setters -> RemoteLockRequest.from ->
// RemoteApiClient.buildLockRequestJson, transliterated from
// lockable-resources-plugin 82532cd
// (https://github.com/jenkinsci/lockable-resources-plugin/tree/82532cdd3585ebefb06241c04aaf6201b4acb5b3).
// Compared over a grid of tricky values.
//
// This reference model is derived from the plugin's code and keeps the
// plugin's notice (LICENSE.txt at that commit):
//
//   The MIT License
//
//   Copyright 2013-2015, 6WIND S.A.
//   Copyright 2016-2018, Antonio Muñiz
//   Copyright 2019-2021, TobiX
//   Copyright 2022-2026, Martin Pokorny and contributors
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in
//   all copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
//   THE SOFTWARE.

interface JenkinsStep {
  resource?: string
  label?: string
  group?: string
  quantity?: number
  variable?: string
  priority?: number
  timeoutForAllocateResource?: number
  timeoutUnit?: string
  reason?: string
  extra?: Array<{
    resource?: string
    label?: string
    quantity?: number
    group?: string
  }>
}

const fixEmptyAndTrim = (s: string | undefined): string | null =>
  s === undefined || s.trim() === '' ? null : s.trim()
const normalizeGroup = (g: string | null): string =>
  fixEmptyAndTrim(g ?? undefined) ?? 'common'

function jenkinsJson(step: JenkinsStep): Record<string, unknown> {
  // LockStep
  const resource = fixEmptyAndTrim(step.resource)
  const label = fixEmptyAndTrim(step.label)
  const variable = fixEmptyAndTrim(step.variable)
  const reason = fixEmptyAndTrim(step.reason)
  const stepGroup = fixEmptyAndTrim(step.group)
  const timeout = Math.max(0, step.timeoutForAllocateResource ?? 0)
  const timeoutUnit =
    fixEmptyAndTrim(step.timeoutUnit)?.toUpperCase() ?? 'MINUTES'
  const quantity = step.quantity ?? 0
  const priority = step.priority ?? 0
  const extra =
    step.extra && step.extra.length > 0
      ? step.extra.map((e) => ({
          resource: fixEmptyAndTrim(e.resource),
          label: fixEmptyAndTrim(e.label),
          quantity: e.quantity ?? 0,
          group: fixEmptyAndTrim(e.group)
        }))
      : null
  const stepGroupOnly =
    stepGroup !== null && resource === null && label === null && extra === null
  // RemoteLockRequest.from
  const passedGroup =
    stepGroupOnly || resource !== null || label !== null || extra !== null
      ? normalizeGroup(stepGroup)
      : null
  const group = fixEmptyAndTrim(passedGroup ?? undefined)
  const groupOnly =
    group !== null && resource === null && label === null && extra === null
  // buildLockRequestJson
  const json: Record<string, unknown> = {}
  if (groupOnly || resource !== null || label !== null || extra !== null)
    json.group = normalizeGroup(group)
  if (resource !== null) json.resource = resource
  if (label !== null) json.label = label
  if (quantity > 0) json.quantity = quantity
  if (variable !== null) json.variable = variable
  json.inversePrecedence = false
  json.resourceSelectStrategy = 'SEQUENTIAL'
  json.skipIfLocked = false
  if (extra !== null) {
    json.extra = extra.map((r) => {
      const o: Record<string, unknown> = {}
      if (r.group !== null) o.group = r.group
      if (r.resource !== null) o.resource = r.resource
      if (r.label !== null) o.label = r.label
      if (r.quantity > 0) o.quantity = r.quantity
      return o
    })
  }
  if (priority > 0) json.priority = priority
  if (timeout > 0) json.timeoutForAllocateResource = timeout
  json.timeoutUnit = timeoutUnit
  if (reason !== null) json.reason = reason
  return json
}

describe('equivalence with the Jenkins client', () => {
  const strings = [undefined, '', '  ', 'x', ' x ']
  const numbers = [undefined, -1, 0, 2]
  const extras: Array<JenkinsStep['extra']> = [
    undefined,
    [],
    [{ resource: 'r4' }],
    [
      { label: 'gpu', quantity: 2 },
      { group: 'g2', quantity: -1 }
    ],
    [{ resource: ' ', label: 'gpu', quantity: 0 }]
  ]
  const cases: JenkinsStep[] = []
  for (const resource of strings)
    for (const label of [undefined, '', 'plc'])
      for (const group of [undefined, '', ' lab '])
        for (const quantity of numbers)
          for (const extra of extras)
            cases.push({ resource, label, group, quantity, extra })
  for (const priority of numbers)
    for (const timeoutForAllocateResource of numbers)
      for (const timeoutUnit of [undefined, '', 'seconds'])
        for (const variable of strings)
          for (const reason of strings)
            cases.push({
              resource: 'r1',
              priority,
              timeoutForAllocateResource,
              timeoutUnit,
              variable,
              reason
            })

  function toInputs(step: JenkinsStep): Record<string, string> {
    const inputs: Record<string, string> = {}
    const put = (name: string, value: string | number | undefined): void => {
      if (value !== undefined) inputs[name] = String(value)
    }
    put('resource', step.resource)
    put('label', step.label)
    put('group', step.group)
    put('quantity', step.quantity)
    put('variable', step.variable)
    put('priority', step.priority)
    put('timeout-for-allocate-resource', step.timeoutForAllocateResource)
    put('timeout-unit', step.timeoutUnit)
    put('reason', step.reason)
    if (step.extra !== undefined) inputs.extra = JSON.stringify(step.extra)
    return inputs
  }

  it(`matches on ${cases.length} combinations, except the documented differences`, () => {
    for (const step of cases) {
      const ours = jsonFor(toInputs(step))
      const theirs = jenkinsJson(step)
      // Difference 1: reason is filled in when empty.
      if (theirs.reason === undefined) {
        expect(ours.reason).toBe(DEFAULT_REASON)
        delete ours.reason
      }
      // Difference 2: a negative priority is sent.
      if ((step.priority ?? 0) < 0) {
        expect(ours.priority).toBe(step.priority)
        delete ours.priority
      }
      expect({ step, json: ours }).toEqual({ step, json: theirs })
    }
  })
})

describe('buildAcquireBody', () => {
  const request = () =>
    readLockInputs((n) => ({ ...CONNECTION, resource: 'r1' })[n] ?? '', ENV)
      .request

  it('sends heartbeatIntervalSeconds 10 and the clientId', () => {
    expect(buildAcquireBody(request(), 'github-actions:octo/repo')).toEqual({
      lockRequest: expect.any(Object),
      heartbeatIntervalSeconds: 10,
      clientId: 'github-actions:octo/repo'
    })
  })

  it('omits an empty clientId', () => {
    expect(buildAcquireBody(request(), '')).not.toHaveProperty('clientId')
  })
})

describe('allocateDeadline', () => {
  const base = readLockInputs(
    (n) => ({ ...CONNECTION, resource: 'r1' })[n] ?? '',
    ENV
  ).request

  it.each([
    [0, 'MINUTES', 0],
    [-3, 'MINUTES', 0],
    [2, 'MINUTES', 1000 + 120_000],
    [5, 'SECONDS', 1000 + 5_000],
    [1, 'HOURS', 1000 + 3_600_000],
    [1500, 'MILLISECONDS', 1000 + 1_500],
    [5, 'NANOSECONDS', 1000]
  ])('timeout %d %s -> %d', (timeout, unit, expected) => {
    expect(
      allocateDeadline(
        { ...base, timeoutForAllocateResource: timeout, timeoutUnit: unit },
        1000
      )
    ).toBe(expected)
  })
})

describe('describeRequest', () => {
  it('names every selector', () => {
    const request = readLockInputs(
      (n) =>
        ({
          ...CONNECTION,
          label: 'plc',
          quantity: '1',
          extra: '- resource: r4'
        })[n] ?? '',
      ENV
    ).request
    expect(describeRequest(request)).toBe(
      "label 'plc', quantity 1 + resource 'r4'"
    )
  })
})
