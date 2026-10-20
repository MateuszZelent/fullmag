import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';
const src=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const cache=new Map();
function load(file){if(cache.has(file))return cache.get(file);const mod=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(file,'utf8'),{mode:'transform'}),{identifier:file});cache.set(file,mod);return mod;}
function linker(spec,ref){if(spec.startsWith('.')||spec.startsWith('@/')){const base=spec.startsWith('@/')?path.join(src,spec.slice(2)):path.resolve(path.dirname(ref.identifier),spec);const file=[base,base+'.ts',path.join(base,'index.ts')].find(f=>fs.existsSync(f)&&fs.statSync(f).isFile());if(!file)throw Error('Unresolved production import '+base);return load(file);}throw Error('Unexpected external production import '+spec);}

const mod=load(path.join(src,'modules/inspector/panels/antenna/AntennaNavigationScene.ts'));await mod.link(linker);await mod.evaluate();
const {antennaNavigationSceneState:state,observeAntennaNavigationScene:observe}=mod.namespace;
const store=cache.get(path.join(src,'kernel/resources/ResourceRuntimeStore.ts')).namespace.sharedResourceRuntimeStore;
const keyFor=cache.get(path.join(src,'kernel/resources/resourceClientScope.ts')).namespace.resourceRuntimeKeyForClientScope;
const scope='session=s&epoch=1&request_scope_epoch=api:1',resourceKey=scope+'|/v2/sessions/current/model/scene',client='observer-client';
const runtimeKey=keyFor(resourceKey,client);
const registryModule=load(path.join(src,'kernel/resources/ResourceInvalidationController.ts'));await registryModule.link(linker);await registryModule.evaluate();
const resources=new registryModule.namespace.ResourceInvalidationController({emit:()=>{}});resources.invalidate(resourceKey,4);
const kernel={api:{resourceCacheScope:client},commands:{getSessionScopeKey:()=>scope},resources};
store.updateData(runtimeKey,{revision:4,objects:[]},4);const states=[];
const unsubscribe=observe(kernel,scope,()=>states.push(state(kernel,scope)));
assert.equal(states.at(-1).scene.revision,4);
const committed={revision:5,objects:[]};store.updateData(runtimeKey,committed,5);
assert.equal(states.at(-1).scene,null,'New data cannot authorize navigation before its external revision settles');
resources.invalidate(resourceKey,5);
assert.equal(states.at(-1).scene,committed,'A later registry invalidation must wake navigation even when the cache is unchanged');
assert.equal(store.hasPendingLoad(runtimeKey),false,'Observation must not create an HTTP loader');
const count=states.length;unsubscribe();
resources.invalidate(resourceKey,6);store.updateData(runtimeKey,{revision:6,objects:[]},6);
assert.equal(states.length,count,'Both subscriptions must be released');
console.log(JSON.stringify({state:'passed',checks:5,unitTestsCompiled:false}));
