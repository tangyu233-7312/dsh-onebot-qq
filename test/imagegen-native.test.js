import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { substituteWorkflow, probeNative, listNativeModels, nativeGenerate } from '../plugins/imagegen/native.js'

const tmpRef = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-native-'))
  const file = path.join(dir, 'ref.png')
  fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9WQAAAABJRU5ErkJggg==', 'base64'))
  return file
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9WQAAAABJRU5ErkJggg==', 'base64')
const TEMPLATE = JSON.stringify({
  '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}, masterpiece' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: '{{negative}}' } },
  '3': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 } },
  '4': { class_type: 'KSampler', inputs: { seed: '{{seed}}', denoise: '{{denoise}}', unknown: '{{not_replaced}}' } },
})

test('原生工作流：占位符按类型替换，未知占位符原样保留', () => {
  const wf = substituteWorkflow(TEMPLATE, { prompt: '一只猫', negative: '', width: 832, height: 1216, seed: 42, denoise: 0.65 })
  assert.equal(wf['1'].inputs.text, '一只猫, masterpiece')
  assert.equal(wf['3'].inputs.width, 832)
  assert.equal(wf['3'].inputs.height, 1216)
  assert.equal(wf['4'].inputs.seed, 42)
  assert.equal(wf['4'].inputs.denoise, 0.65)
  assert.equal(wf['4'].inputs.unknown, '{{not_replaced}}')
})

test('原生工作流：空模板、非法 JSON、普通 UI 工作流都明确报错', () => {
  assert.throws(() => substituteWorkflow('', {}), /还没填本机工作流模板/)
  assert.throws(() => substituteWorkflow('{bad', {}), /不是合法 JSON/)
  assert.throws(() => substituteWorkflow('[]', {}), /Save \(API Format\)/)
})

function mockNative(t, options = {}) {
  const calls = []
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    calls.push({ url: u, opts })
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    if (u.endsWith('/system_stats')) return options.alive === false ? json({ error: 'off' }, 500) : json({ devices: [{ name: 'GPU', vram_free: 4096 * 1048576 }] })
    if (u.includes('/object_info/')) {
      const node = u.split('/').pop()
      const field = node === 'CheckpointLoaderSimple' ? 'ckpt_name' : node === 'UNETLoader' ? 'unet_name' : 'vae_name'
      return json({ [node]: { input: { required: { [field]: [[node + '-model.safetensors']] } } } })
    }
    if (u.endsWith('/upload/image')) return json({ name: 'uploaded.png' })
    if (u.endsWith('/prompt')) return json({ prompt_id: 'job-1', node_errors: options.nodeErrors || {} })
    if (u.endsWith('/history/job-1')) return json(options.history || { 'job-1': { status: { completed: true, status_str: 'success' }, outputs: { '9': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] } } } })
    if (u.startsWith('http://local/view?')) return new Response(PNG)
    throw new Error('意外请求 ' + u)
  }
  return calls
}

test('原生 ComfyUI：探活用 /system_stats，模型清单由 object_info 提供', async (t) => {
  mockNative(t)
  assert.deepEqual(await probeNative('http://local'), { ok: true, reason: '', gpu: 'GPU', vramFreeMB: 4096 })
  const models = await listNativeModels('http://local')
  assert.equal(models.ok, true)
  assert.equal(models.items.length, 3)
})

test('原生 ComfyUI：提交替换后的工作流，轮询 history 并取图', async (t) => {
  const calls = mockNative(t)
  const file = await nativeGenerate({ prompt: '画猫', size: '1024x1024', local: { baseUrl: 'http://local', workflow: TEMPLATE, denoise: 0.65 }, timeoutMs: 10000 })
  assert.ok(file.endsWith('.png'))
  const submitted = JSON.parse(calls.find((c) => c.url.endsWith('/prompt')).opts.body)
  assert.equal(submitted.prompt['1'].inputs.text, '画猫, masterpiece')
  assert.equal(submitted.prompt['3'].inputs.width, 1024)
  assert.ok(calls.some((c) => c.url.includes('filename=result.png')))
})

test('原生 ComfyUI：模板缺 {{prompt}}、图生图缺 {{image}} 都明确报错', async (t) => {
  mockNative(t)
  const noPrompt = JSON.stringify({ '9': { class_type: 'SaveImage', inputs: { images: [['8', 0]] } } })
  await assert.rejects(
    () => nativeGenerate({ prompt: '画猫', local: { baseUrl: 'http://local', workflow: noPrompt }, timeoutMs: 10000 }),
    /没有 \{\{prompt\}\} 占位符/,
  )
  const withPrompt = JSON.stringify({ '5': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } })
  await assert.rejects(
    () => nativeGenerate({ prompt: '画猫', refs: [tmpRef()], local: { baseUrl: 'http://local', workflow: withPrompt }, timeoutMs: 10000 }),
    /没有 \{\{image\}\} 占位符/,
  )
})

test('原生 ComfyUI：节点错误直接报出，不静默当成功', async (t) => {
  mockNative(t, { nodeErrors: { '4': { errors: [{ message: 'bad sampler' }] } } })
  await assert.rejects(() => nativeGenerate({ prompt: '画猫', local: { baseUrl: 'http://local', workflow: TEMPLATE }, timeoutMs: 10000 }), /工作流有节点报错/)
})
