import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import video from '../plugins/video-link-read/index.js'
import parser from '../plugins/link-parser/index.js'
import { startSidecar } from './sidecar-fixture.mjs'

test('HTTP 字幕缓存：parse/read 两个方向复用，开关与登录态改变失效，字数改变复用', async t => {
  const s = await startSidecar(t)
  const base = { url: 'https://www.bilibili.com/video/BV1xx411c7mD', platform: 'bilibili' }
  await s.request('/config', { biliCookies: 'fixture=value', subtitle: false })
  const off = await s.request('/read', base)
  assert.equal(off.subtitleStatus, 'disabled')
  const on = await s.request('/read', { ...base, subtitle: true })
  assert.equal(on.subtitleStatus, 'available')
  assert.match(on.subtitle.text, /字幕测试内容/)
  assert.notEqual(on.mediaPath, off.mediaPath)
  const parsed = await s.request('/parse', { ...base, subtitle: true })
  assert.equal(parsed.reused, true)
  const smaller = await s.request('/read', { ...base, subtitle: true, subtitleMaxChars: 500 })
  assert.equal(smaller.mediaPath, on.mediaPath, '改字数不重复下载')
  await s.request('/config', { biliCookies: 'fixture=updated', subtitle: true })
  const renewed = await s.request('/parse', base)
  assert.equal(renewed.ok, true)
  assert.notEqual(renewed.reused, true, '登录态改变需重新下载')
  const read = await s.request('/read', base)
  assert.equal(read.subtitleStatus, 'available')
  assert.equal(read.mediaPath, renewed.media[0].path, 'parse 后 read 复用相同源文件')
  const disabled = await s.request('/read', { ...base, subtitle: false })
  assert.equal(disabled.subtitle, null)
  assert.equal(disabled.subtitleStatus, 'disabled')
})

function bot(plugin,shared,overrides={}) {
  const hooks={};const cfg=Object.fromEntries(Object.entries(plugin.configSchema).map(([k,v])=>[k,v.default]))
  Object.assign(cfg,overrides)
  plugin.setup({cfg,shared,on:(stage,f)=>{hooks[stage]=f},log:{info(){},warn(){},debug(){},error(){}},state:{get:()=>({})},sendMedia:async()=>{},deliver:async()=>{}})
  return {hooks,cfg}
}
test('统一配置下载前同步；热改生效；搬运关闭也能直接读 BV',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'subtitle-plugin-'))
  const frame=path.join(dir,'frame.jpg');fs.writeFileSync(frame,Buffer.from([255,216,255,217]))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const shared={};const v=bot(video,shared,{subtitle:true,subtitleMaxChars:500,extras:false})
  const p=bot(parser,shared,{enabled:false,biliCookie:'EXAMPLE_LOGIN',subtitle:false})
  const calls=[];const original=globalThis.fetch
  globalThis.fetch=async(url,opts)=>{
    const route=new URL(url).pathname;calls.push({route,body:JSON.parse(opts.body)})
    return new Response(JSON.stringify(route==='/read'?{ok:true,platform:'bilibili',durationSec:60,frames:[{path:frame,sec:1}],subtitle:{text:'字'.repeat(800)},subtitleStatus:'available'}:{ok:true,media:[],skipped:[],platform:'bilibili'}))
  }
  t.after(()=>{globalThis.fetch=original})
  const event=()=>({rawText:'BV1xx411c7mD',text:'BV1xx411c7mD',isGroup:false,imageParts:[],hint:[],_scratch:{},sender:{qq:10001},chatKey:'private:10001'})
  const first=event();await v.hooks['before-turn'](first)
  assert.deepEqual(calls.map(c=>c.route),['/config','/read'])
  assert.equal(calls[0].body.subtitle,true);assert.equal(calls[1].body.subtitleMaxChars,500)
  assert.equal(first.hint.find(h=>h.startsWith('[视频字幕')).split('\n')[1].length,500)
  calls.length=0;v.cfg.subtitle=false
  const off=event();await v.hooks['before-turn'](off)
  assert.deepEqual(calls.map(c=>c.route),['/config','/read'])
  assert.equal(calls[0].body.subtitle,false);assert.equal(calls[1].body.subtitle,false)
  assert.equal(off.hint.some(h=>h.startsWith('[视频字幕')),false)
  calls.length=0;p.cfg.enabled=true;p.cfg.biliCookie='EXAMPLE_UPDATED';v.cfg.subtitle=true;v.cfg.subtitleMaxChars=2000
  await p.hooks.intercept({...event(),text:'看 https://b23.tv/abc',rawText:'看 https://b23.tv/abc',cards:[]})
  assert.deepEqual(calls.map(c=>c.route),['/config','/parse'])
  assert.equal(calls[0].body.biliCookies,'EXAMPLE_UPDATED');assert.equal(calls[1].body.subtitle,true)
  assert.equal(calls[1].body.subtitleMaxChars,2000)
})
