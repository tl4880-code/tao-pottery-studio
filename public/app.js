import * as THREE from '/vendor/three.module.js';

const $ = (id) => document.getElementById(id);
const glazes = {
  raw: { name: 'Clay', color: '#a97659', roughness: .88, coat: 0 },
  celadon: { name: 'Celadon', color: '#a7bfac', roughness: .23, coat: .9 },
  ivory: { name: 'Ivory', color: '#e2d9bd', roughness: .2, coat: 1 },
  ink: { name: 'Ink', color: '#353e36', roughness: .28, coat: .8 },
  ochre: { name: 'Ochre', color: '#a16a32', roughness: .26, coat: .85 },
};
const initialProfile = () => Array.from({ length: 48 }, (_, i) => {
  const t = i / 47;
  return .68 + .24 * Math.sin(Math.PI * t * .87) - .13 * Math.pow(t, 5);
});
const state = { profile: initialProfile(), height: 2.65, glaze: 'celadon', stage: 'shape', saving: false };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let renderer, scene, camera, pot, wheel, material, cursorRing, resizeObserver;
let dragging = null, lastTime = 0, toastTimer;
let draftTimer, saveToken = null;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const planePoint = new THREE.Vector3();

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3500);
}
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try { localStorage.setItem('tao-draft-v1', JSON.stringify({ profile: state.profile, height: state.height, glaze: state.glaze, stage: state.stage === 'firing' ? 'glaze' : state.stage })); } catch { /* The studio also works without local storage. */ }
  }, 300);
}
function restoreDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem('tao-draft-v1'));
    if (draft && Array.isArray(draft.profile) && draft.profile.length === 48 && draft.profile.every(n => Number.isFinite(n) && n >= .35 && n <= 1.55) && Number.isFinite(draft.height) && draft.height >= 1.8 && draft.height <= 3.8 && glazes[draft.glaze] && ['shape', 'glaze', 'finished'].includes(draft.stage)) {
      Object.assign(state, draft);
    }
  } catch { /* Ignore outdated or incomplete drafts. */ }
}

function clayTexture() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d');
  const pixels = ctx.createImageData(512, 512);
  for (let y = 0; y < 512; y++) {
    const ring = Math.sin(y * .55) * 8 + Math.sin(y * .15) * 4;
    for (let x = 0; x < 512; x++) {
      const index = (y * 512 + x) * 4;
      const value = 160 + ring + (Math.random() - .5) * 35;
      pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = value;
      pixels.data[index + 3] = 255;
    }
  }
  ctx.putImageData(pixels, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 1.5);
  return texture;
}

function geometry() {
  const points = [new THREE.Vector2(0, .04), new THREE.Vector2(state.profile[0] * .84, .04)];
  for (let i = 0; i < 48; i++) points.push(new THREE.Vector2(state.profile[i], .11 + i / 47 * state.height));
  const rim = state.profile[47], top = state.height + .11;
  for (let i = 1; i <= 8; i++) {
    const a = Math.PI * i / 8;
    points.push(new THREE.Vector2(rim - .045 + .045 * Math.cos(a), top + .045 * Math.sin(a)));
  }
  for (let i = 46; i >= 2; i--) points.push(new THREE.Vector2(Math.max(.21, state.profile[i] - .09), .11 + i / 47 * state.height));
  points.push(new THREE.Vector2(0, .22));
  return new THREE.LatheGeometry(points, 120);
}

function updateShape() {
  if (!pot) return;
  pot.geometry.dispose(); pot.geometry = geometry();
  $('height').value = state.height;
  $('height-value').textContent = `${Math.round(state.height * 9)} cm`;
  $('radius').value = state.profile[Number($('level').value)];
  saveDraft();
}

function applyGlaze() {
  const g = glazes[state.stage === 'shape' ? 'raw' : state.glaze];
  if (material) {
    material.color.set(g.color);
    material.roughness = g.roughness;
    material.clearcoat = g.coat;
    material.bumpScale = state.stage === 'shape' || state.glaze === 'raw' ? .017 : .004;
  }
  $('material-label').textContent = state.stage === 'shape' ? 'Clay · Unfired' : `${g.name} · ${state.stage === 'finished' ? 'Fired' : 'Ready to fire'}`;
  $('glaze-name').textContent = glazes[state.glaze].name;
  document.querySelectorAll('[data-glaze]').forEach(button => {
    const selected = button.dataset.glaze === state.glaze;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', selected);
  });
}

function setStage(stage) {
  if (state.stage === 'firing') return;
  state.stage = stage;
  const isShape = stage === 'shape', finished = stage === 'finished';
  $('height-controls').hidden = !isShape;
  $('glaze-controls').hidden = stage !== 'glaze';
  $('finish-controls').hidden = !finished;
  $('keyboard-toggle').hidden = !isShape;
  $('keyboard-panel').hidden = true;
  $('keyboard-toggle').setAttribute('aria-expanded', 'false');
  $('gesture-hint').textContent = isShape ? 'Drag the clay inward or outward.' : finished ? 'Your piece is ready.' : 'Choose a glaze.';
  $('gesture-hint').style.opacity = '1';
  $('object-caption').textContent = finished ? 'MADE BY YOU' : '';
  $('next-stage').innerHTML = `<span>${isShape ? 'Choose glaze' : finished ? 'Save piece' : 'Fire piece'}</span><span>→</span>`;
  $('status-text').textContent = isShape ? '01 / Shape' : finished ? '03 / Finished' : '02 / Glaze';
  document.querySelectorAll('[data-stage]').forEach(button => {
    const active = button.dataset.stage === (finished ? 'fire' : stage);
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
  });
  applyGlaze(); saveDraft();
}

function createScene() {
  const container = $('scene');
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
  container.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-5, 5, 3, -3, .1, 50);
  camera.position.set(0, 4.4, 9); camera.lookAt(0, 1.5, 0);
  scene.add(new THREE.HemisphereLight(0xfffaf0, 0xa8aa93, 2.5));
  const key = new THREE.DirectionalLight(0xfff1db, 3.7); key.position.set(-3, 6, 4); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); key.shadow.camera.left = -4; key.shadow.camera.right = 4;
  key.shadow.camera.top = 5; key.shadow.camera.bottom = -4; key.shadow.normalBias = .025;
  key.shadow.bias = -.0001; key.shadow.radius = 5; scene.add(key);
  const fill = new THREE.DirectionalLight(0xe6eee4, 1.4); fill.position.set(4, 2, -2); scene.add(fill);
  const envScene = new THREE.Scene(); envScene.background = new THREE.Color('#d6d7c9');
  for (const [x,y,z,sx,sy] of [[-3,3,2,3,6],[4,3,-1,2,5],[0,6,0,7,7]]) {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(sx, sy), new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide }));
    panel.position.set(x,y,z); panel.lookAt(0,1,0); envScene.add(panel);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, .025).texture; pmrem.dispose();
  envScene.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
  material = new THREE.MeshPhysicalMaterial({ color: '#a97659', roughness: .88, clearcoatRoughness: .15, bumpMap: clayTexture(), bumpScale: .017, envMapIntensity: .55 });
  pot = new THREE.Mesh(geometry(), material); pot.castShadow = true; pot.receiveShadow = true; scene.add(pot);
  wheel = new THREE.Group(); scene.add(wheel);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.66,1.7,.12,128), new THREE.MeshStandardMaterial({ color:'#c1c0ad',roughness:.92 }));
  disc.position.y = -.025; disc.receiveShadow = true; disc.castShadow = true; wheel.add(disc);
  for (const radius of [1.1,1.32,1.48,1.6]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius,.003,6,140),new THREE.MeshBasicMaterial({color:'#aaa997',transparent:true,opacity:.6}));
    ring.rotation.x = Math.PI / 2; ring.position.y = .038; wheel.add(ring);
  }
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.ShadowMaterial({color:'#41462f',opacity:.12}));
  ground.rotation.x=-Math.PI/2; ground.position.y=-.1; ground.receiveShadow=true; scene.add(ground);
  cursorRing = new THREE.Mesh(new THREE.TorusGeometry(1,.006,5,100), new THREE.MeshBasicMaterial({color:'#faf1df',transparent:true,opacity:.45,depthTest:false}));
  cursorRing.rotation.x=Math.PI/2; cursorRing.visible=false; scene.add(cursorRing);
  const resize = () => {
    const {width,height} = container.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width,height,false);
    const mobile = width < 600;
    const span = mobile ? 5.35 : 5.4;
    camera.left = -span * width / height / 2; camera.right = -camera.left;
    camera.top = span/2; camera.bottom = -span/2; camera.updateProjectionMatrix();
    camera.position.set(0,mobile ? 4.8 : 4.4,9); camera.lookAt(0,mobile ? 1.4 : 1.4,0);
  };
  resizeObserver = new ResizeObserver(resize); resizeObserver.observe(container); resize();
  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('pointercancel', pointerUp);
  canvas.addEventListener('lostpointercapture', pointerUp);
  canvas.addEventListener('pointerleave', () => { if (!dragging) cursorRing.visible = false; });
  renderer.setAnimationLoop(time => {
    const delta = Math.min((time-lastTime)/1000,.04); lastTime = time;
    if (!document.hidden && !reduceMotion && !dragging && !document.querySelector('dialog[open]')) {
      pot.rotation.y += delta * .12; wheel.rotation.y += delta * .12;
    }
    renderer.render(scene,camera);
  });
}

function rayAt(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
  raycaster.setFromCamera(pointer,camera);
  return rect;
}
function pointerDown(event) {
  if (state.stage !== 'shape' || event.button !== 0) return;
  rayAt(event);
  const hit = raycaster.intersectObject(pot)[0];
  if (!hit) return;
  dragging = { id: event.pointerId, x: event.clientX, side: hit.point.x >= 0 ? 1 : -1 };
  renderer.domElement.setPointerCapture(event.pointerId);
  $('gesture-hint').style.opacity = '.2';
  pointerMove(event);
}
function pointerMove(event) {
  if (state.stage !== 'shape') { cursorRing.visible=false; return; }
  const rect=rayAt(event);
  const hit=raycaster.intersectObject(pot)[0];
  if (!dragging && !hit) { cursorRing.visible=false; return; }
  raycaster.ray.intersectPlane(plane,planePoint);
  const y=hit?.point.y ?? planePoint.y;
  const level=Math.max(1,Math.min(47,Math.round((y-.11)/state.height*47)));
  cursorRing.visible=true; cursorRing.position.y=.11+level/47*state.height;
  cursorRing.scale.setScalar(state.profile[level]+.014);
  if (!dragging || dragging.id !== event.pointerId) return;
  const delta=(event.clientX-dragging.x)/rect.height*5.4*dragging.side;
  const previous=[...state.profile];
  for(let i=1;i<48;i++) {
    const weight=Math.exp(-Math.pow((i-level)/5,2)*.5);
    state.profile[i]=THREE.MathUtils.clamp(previous[i]+delta*weight,.35,1.55);
  }
  dragging.x=event.clientX;
  updateShape();
}
function pointerUp(event) {
  if (!dragging || (event.pointerId !== undefined && event.pointerId !== dragging.id)) return;
  dragging=null; cursorRing.visible=false;
  $('gesture-hint').style.opacity='1'; saveDraft();
}

function fire() {
  if (state.stage !== 'glaze') return;
  state.stage='firing'; cursorRing.visible=false;
  $('firing-veil').hidden=false; $('next-stage').disabled=true;
  $('kiln-progress').style.width='0';
  const start=performance.now(), duration=reduceMotion ? 500 : 2500;
  const tick=now => {
    const progress=Math.min((now-start)/duration,1);
    $('kiln-progress').style.width=`${progress*100}%`;
    $('firing-caption').textContent=progress < .7 ? 'Firing your piece…' : 'Cooling down…';
    if (progress<1) requestAnimationFrame(tick);
    else {
      state.stage='glaze'; setStage('finished'); $('firing-veil').hidden=true;
      $('next-stage').disabled=false;
      toast('Ready to save.');
    }
  };
  requestAnimationFrame(tick);
}

function thumbnail() {
  cursorRing.visible=false;
  const aspect=camera.aspect, left=camera.left, right=camera.right;
  const capture=document.createElement('canvas'); capture.width=420; capture.height=360;
  const ctx=capture.getContext('2d');
  const originalSize=new THREE.Vector2(); renderer.getSize(originalSize);
  const pixelRatio=renderer.getPixelRatio();
  camera.left=-3.15; camera.right=3.15; camera.updateProjectionMatrix();
  renderer.setPixelRatio(1); renderer.setSize(420,360,false); renderer.render(scene,camera);
  ctx.fillStyle='#eeeee5'; ctx.fillRect(0,0,420,360); ctx.drawImage(renderer.domElement,0,0);
  camera.left=left; camera.right=right; camera.aspect=aspect; camera.updateProjectionMatrix();
  renderer.setPixelRatio(pixelRatio); renderer.setSize(originalSize.x,originalSize.y,false); renderer.render(scene,camera);
  return capture.toDataURL('image/png');
}

async function loadGallery(show = false) {
  if (show) { $('gallery-dialog').showModal(); $('gallery-grid').replaceChildren(); galleryMessage('Loading pieces…'); }
  $('refresh-gallery').disabled=true;
  try {
    const response=await fetch('/api/pots',{cache:'no-store'});
    if(!response.ok) throw new Error('collection unavailable');
    const {pots}=await response.json();
    $('collection-count').textContent=pots.length;
    if (!show && !$('gallery-dialog').open) return;
    $('gallery-grid').replaceChildren();
    if(!pots.length) {
      const empty=document.createElement('div'); empty.className='gallery-empty';
      empty.innerHTML='<h3>The shelf is empty.</h3><p>Make the first piece.</p><button class="primary-button">Back to studio →</button>';
      empty.querySelector('button').onclick=()=>$('gallery-dialog').close(); $('gallery-grid').append(empty);
    } else for(const item of pots) {
      const card=document.createElement('article'); card.className='pot-card';
      const img=document.createElement('img'); img.src=item.thumbnail; img.alt=item.name; img.loading='lazy';
      const title=document.createElement('h3'); title.textContent=item.name;
      const info=document.createElement('p'),author=document.createElement('span'),glaze=document.createElement('span');
      author.textContent=item.author;
      glaze.textContent=`${glazes[item.glaze]?.name || 'Ceramic'} · ${new Date(item.createdAt).toLocaleDateString('en-US',{month:'short',day:'numeric'})}`;
      info.append(author,glaze); card.append(img,title,info); $('gallery-grid').append(card);
    }
  } catch {
    if(show || $('gallery-dialog').open) { $('gallery-grid').replaceChildren(); galleryMessage('Could not load the gallery. Please try Refresh.'); }
  } finally { $('refresh-gallery').disabled=false; }
}
function galleryMessage(message) { const p=document.createElement('p'); p.className='gallery-empty'; p.textContent=message; $('gallery-grid').append(p); }

async function savePot(event) {
  event.preventDefault(); if(state.saving || state.stage !== 'finished') return;
  state.saving=true; $('save-error').textContent=''; $('save-submit').disabled=true;
  $('save-submit').firstElementChild.textContent='Saving…';
  try {
    const response=await fetch('/api/pots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('pot-name').value.trim(),author:$('pot-author').value.trim(),profile:state.profile,height:state.height,glaze:state.glaze,thumbnail:thumbnail()})});
    if(!response.ok) throw new Error('save failed');
    const {pot:saved}=await response.json();
    saveToken=saved.id; $('save-dialog').close();
    $('status-text').textContent='Saved to gallery';
    toast('Saved. Others can now see your piece.');
    await loadGallery(true);
  } catch { $('save-error').textContent='Could not save. Your piece is still here. Please try again.'; }
  finally { state.saving=false; $('save-submit').disabled=false; $('save-submit').firstElementChild.textContent='Save to gallery'; }
}

function wireControls() {
  $('height').oninput=()=>{state.height=Number($('height').value);updateShape();};
  $('level').oninput=()=>{$('radius').value=state.profile[Number($('level').value)];$('level-value').textContent=Number($('level').value)<16?'Base':Number($('level').value)<33?'Middle':'Rim';};
  $('radius').oninput=()=>{
    const level=Number($('level').value),delta=Number($('radius').value)-state.profile[level];
    for(let i=1;i<48;i++)state.profile[i]=THREE.MathUtils.clamp(state.profile[i]+delta*Math.exp(-Math.pow((i-level)/5,2)*.5),.35,1.55);
    updateShape();
  };
  $('keyboard-toggle').onclick=()=>{const open=$('keyboard-panel').hidden;$('keyboard-panel').hidden=!open;$('keyboard-toggle').setAttribute('aria-expanded',open);if(open)$('level').focus();};
  document.querySelectorAll('[data-glaze]').forEach(button=>button.onclick=()=>{state.glaze=button.dataset.glaze;saveToken=null;applyGlaze();saveDraft();});
  document.querySelectorAll('[data-stage]').forEach(button=>button.onclick=()=>{if(state.stage==='firing')return;saveToken=null;setStage(button.dataset.stage);});
  $('next-stage').onclick=()=>{
    if(state.stage==='shape') setStage('glaze');
    else if(state.stage==='glaze') fire();
    else if(state.stage==='finished') {
      if(saveToken){loadGallery(true);return;}
      $('save-error').textContent='';$('save-dialog').showModal();$('pot-name').focus();
    }
  };
  $('reset').onclick=()=>$('reset-dialog').showModal();
  $('confirm-reset').onclick=()=>{Object.assign(state,{profile:initialProfile(),height:2.65});saveToken=null;$('reset-dialog').close();$('save-form').reset();setStage('shape');updateShape();toast('A fresh start.');};
  $('save-form').onsubmit=savePot;
  $('gallery-nav').onclick=()=>loadGallery(true); $('refresh-gallery').onclick=()=>loadGallery();
  $('studio-nav').onclick=()=>{document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());};
  document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>{if(button.dataset.close==='save-dialog'&&state.saving)return;$(button.dataset.close).close();});
  $('save-dialog').addEventListener('cancel',e=>{if(state.saving)e.preventDefault();});
}

restoreDraft(); wireControls();
try { createScene(); updateShape(); setStage(state.stage); }
catch (error) {
  console.error('The pottery scene could not start:',error);
  $('scene').innerHTML='<div class="scene-error">This studio needs WebGL.<br>Enable browser hardware acceleration or try another browser.<button class="primary-button" id="retry-scene">Reload →</button></div>';
  $('retry-scene').onclick=()=>location.reload(); $('next-stage').disabled=true;
}
loadGallery();
