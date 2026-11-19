import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import crypto from 'node:crypto'
import video from '../plugins/video-link-read/index.js'
import parser from '../plugins/link-parser/index.js'
import { subtitleText } from '../sidecar/subtitle.mjs'
const source = fs.readFileSync(new URL('../sidecar/server.mjs', import.meta.url), 'utf8')
function fn(name) {
  const start = source.indexOf('function ' + name + '(')
  const a = source.slice(start - 6, start) === 'async ' ? start - 6 : start
  const end = source.indexOf('\n}\n', start) + 3
  assert.ok(start >= 0 && end > start, name)
  return source.slice(a, end)
}
function sidecar(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-flow-'))
  const sub = path.join(dir, 'video.ai-zh.srt')
  fs.writeFileSync(sub, '1\n00:00:01,000 --> 00:00:03,000\n字幕测试内容\n\n2\n00:01:01,000 --> 00:01:03,000\n结尾字幕\n')
  const file = path.join(dir, 'video.mp4')
  fs.writeFileSync(file, 'fixture')
  const calls = []
  const cfg = {concurrency:2,maxMb:250,subtitle:false,subtitleMaxChars:6000,reuseMinutes:10}
  const c = vm.createContext({
    CFG:cfg,fs,crypto,path,FRAME_DIR:dir,DL_DIR:dir,running:0,
    recentDownloads:new Map(),lastSubs:new Map(),nowMs:()=>1000,reuseMs:()=>600000,
    rand:()=> 'fixture',log(){},mb:n=>n/1048576,hostAllowed:()=>({ok:true}),
    fsp:{mkdir:async()=>{},stat:async()=>({size:7}),rm:async()=>{}},
    ytdlpMeta:async()=>({title:'fixture',durationSec:60,platform:'bilibili'}),
    ytdlpDownload:async(url,out,options)=>{
      calls.push(options)
      const has=options.subtitle && cfg.biliCookies
      return {ok:true,file,size:7,subs:has?[sub]:[],subtitleStatus:!options.subtitle?'disabled':has?'downloaded':'login_required'}
    },
    limitOf:()=>({seconds:1500,frames:8}),
    extractFrames:async()=>({ok:true,durationSec:60,frames:[{path:file,sec:1}]}),subtitleText,
  })
  vm.runInContext(['subtitleOptions','subtitleCacheKey','cachedDownload','rememberDownload','handleParse','handleRead'].map(fn).join('\n'),c)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  return {c,cfg,calls,body:{url:'https://www.bilibili.com/video/BV1xx411c7mD',platform:'bilibili',subtitle:true}}
}
test('字幕 /parse → /read 复用仍保留字幕，只下载一次',async t=>{
  const {c,cfg,calls,body}=sidecar(t);cfg.biliCookies='EXAMPLE_LOGIN'
  assert.equal((await c.handleParse(body)).ok,true)
  c.lastSubs.clear()
  const read=await c.handleRead(body)
  assert.equal(read.ok,true);assert.match(read.subtitle.text,/字幕测试内容/)
  assert.equal(read.subtitleStatus,'available');assert.equal(calls.length,1)
})
test('字幕 /read → /parse 反向复用不重复下载',async t=>{
  const {c,cfg,calls,body}=sidecar(t);cfg.biliCookies='EXAMPLE_LOGIN'
  assert.equal((await c.handleRead(body)).subtitleStatus,'available')
  assert.equal((await c.handleParse(body)).reused,true);assert.equal(calls.length,1)
})
test('开启字幕、更换登录态失效旧缓存，字数调整直接复用',async t=>{
  const {c,cfg,calls,body}=sidecar(t)
  assert.equal((await c.handleRead({...body,subtitle:false})).subtitleStatus,'disabled')
  assert.equal((await c.handleRead(body)).subtitleStatus,'login_required')
  cfg.biliCookies='EXAMPLE_LOGIN'
  assert.equal((await c.handleRead(body)).subtitleStatus,'available');assert.equal(calls.length,3)
  await c.handleRead({...body,subtitleMaxChars:500});assert.equal(calls.length,3)
  cfg.biliCookies='EXAMPLE_UPDATED'
  await c.handleRead(body);assert.equal(calls.length,4)
})
test('请求开关覆盖侧车旧值；关闭不返回字幕；字数有边界',async t=>{
  const {c,cfg,body}=sidecar(t);cfg.biliCookies='EXAMPLE_LOGIN'
  assert.equal((await c.handleRead(body)).subtitleStatus,'available')
  const off=await c.handleRead({...body,subtitle:false})
  assert.equal(off.subtitle,null);assert.equal(off.subtitleStatus,'disabled')
  assert.equal(c.subtitleOptions({subtitleMaxChars:999999}).subtitleMaxChars,20000)
  assert.equal(c.subtitleOptions({subtitleMaxChars:1}).subtitleMaxChars,500)
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
