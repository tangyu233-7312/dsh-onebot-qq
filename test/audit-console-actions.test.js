/**
 * test/audit-console-actions.test.js — 控制台动作按钮的字段契约（2026-10-30）
 *
 * 背景：前端 client.js 的 GroupTab 是这样筛的 ——
 *   const acts = (schema.actions || []).filter((a) => a.onGroup && a.group === group)
 * 后端 visibleActions() 只要漏掉 onGroup，所有「长在配置页底部」的按钮就会**静默消失**。
 * 踩过一次：加了「重置视频额度与冷却」，面板上根本看不到。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACTIONS, visibleActions } from '../admin/schema.js'

test('visibleActions 必须带出 onGroup（否则配置页底部的按钮会全部消失）', () => {
  const list = visibleActions()
  assert.ok(list.length > 0)
  for (const a of list) {
    assert.equal(typeof a.onGroup, 'boolean', a.id + ' 缺少 onGroup 字段')
  }
})

test('每个 onGroup 的动作都能在它那个分组里被筛出来', () => {
  const list = visibleActions()
  const onGroupOnes = list.filter((a) => a.onGroup)
  assert.ok(onGroupOnes.length >= 3, '至少有 立刻回顾 / 重置空间额度 / 立刻看一个 / 重置视频额度')
  for (const a of onGroupOnes) {
    const hit = list.filter((x) => x.onGroup && x.group === a.group)
    assert.ok(hit.some((x) => x.id === a.id), a.id + ' 在自己的分组里筛不出来')
  }
})

test('隐藏动作不出现在可见列表里', () => {
  const hiddenIds = ACTIONS.filter((a) => a.hidden).map((a) => a.id)
  const visibleIds = visibleActions().map((a) => a.id)
  for (const id of hiddenIds) assert.equal(visibleIds.includes(id), false, id + ' 不该出现')
})

test('「重置视频额度与冷却」这个按钮存在且带二次确认', () => {
  const a = visibleActions().find((x) => x.id === 'wander-reset-quota')
  assert.ok(a, '按钮不见了')
  assert.equal(a.group, '自己找视频看')
  assert.equal(a.onGroup, true, '要长在「自己找视频看」页底部，不是运维页')
  assert.ok(a.confirm && a.confirm.title, '重置类操作必须有二次确认')
})
