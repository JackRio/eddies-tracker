// Gig rolls in real 3D, without physics: three.js draws a proper die (d4 d6 d8 d10 d12 d20 - numbers printed on
// every face, glossy plastic, edge lines, soft shadow) and a scripted throw moves it: in from its owner's side,
// three bounces, a tumble that slows down, landing with the engine's number on top. The number comes from the
// game (its seeded RNG); every throw's path, spin axis, turns and bounce heights are random. Nothing is drawn
// while no die is moving. three.js: board/vendor/three/three-dice.min.js (only the classes used here).
// If WebGL is unavailable, Dice3D.ok becomes false and app.js keeps its 2D tumble.
//   await Dice3D.roll(sides, value, owner, at)  owner: 'mine' | 'theirs'; at: { x, y, size } screen box to land in
'use strict';
(function () {
  let T = null, renderer = null, scene = null, camera = null, cv = null, loading = null;
  const active = [];
  let raf = 0;

  // ── the solids (unit circumradius), faces wound outward, numbers 1..N with opposite faces summing to N+1 ──
  const PHI = (1 + Math.sqrt(5)) / 2;
  const V = {
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    mul: (a, k) => [a[0] * k, a[1] * k, a[2] * k], dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: a => Math.hypot(a[0], a[1], a[2]),
  };
  V.norm = a => V.mul(a, 1 / (V.len(a) || 1));
  const mean = pts => V.mul(pts.reduce(V.add, [0, 0, 0]), 1 / pts.length);
  const combos = (n, k) => { const out = []; const go = (s, a) => { if (a.length === k) { out.push(a); return; } for (let i = s; i < n; i++) go(i + 1, [...a, i]); }; go(0, []); return out; };
  function face(verts, idx) {
    const c = mean(idx.map(i => verts[i])), n0 = V.norm(c), u = V.norm(V.sub(verts[idx[0]], c)), w = V.cross(n0, u);
    const ang = i => { const p = V.sub(verts[i], c); return Math.atan2(V.dot(p, w), V.dot(p, u)); };
    const ord = idx.slice().sort((a, b) => ang(a) - ang(b));
    let n = V.norm(V.cross(V.sub(verts[ord[1]], verts[ord[0]]), V.sub(verts[ord[2]], verts[ord[0]])));
    if (V.dot(n, c) < 0) { ord.reverse(); n = V.mul(n, -1); }
    return { v: ord, n, c };
  }
  function solid(sides) {
    let verts, faces;
    if (sides === 4) { verts = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]]; faces = combos(4, 3); }
    else if (sides === 6) {
      verts = []; for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) verts.push([x, y, z]);
      faces = []; for (let a = 0; a < 3; a++) for (const s of [-1, 1]) faces.push(verts.map((p, i) => (p[a] === s ? i : -1)).filter(i => i >= 0));
    } else if (sides === 8) {
      verts = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      faces = []; for (const x of [0, 1]) for (const y of [2, 3]) for (const z of [4, 5]) faces.push([x, y, z]);
    } else if (sides === 10) {
      // pentagonal trapezohedron; apex height keeps each kite flat
      const z0 = 0.105, c36 = Math.cos(Math.PI / 5), h = z0 * (1 + c36) / (1 - c36);
      verts = [[0, 0, h], [0, 0, -h]];
      for (let k = 0; k < 10; k++) verts.push([Math.cos(k * Math.PI / 5), Math.sin(k * Math.PI / 5), k % 2 ? -z0 : z0]);
      const r = k => 2 + ((k % 10) + 10) % 10;
      faces = []; for (let i = 0; i < 5; i++) faces.push([0, r(2 * i), r(2 * i + 1), r(2 * i + 2)], [1, r(2 * i + 1), r(2 * i + 2), r(2 * i + 3)]);
    } else {
      // icosahedron; the d12 is its dual
      const ico = []; for (const a of [-1, 1]) for (const b of [-PHI, PHI]) ico.push([0, a, b], [a, b, 0], [b, 0, a]);
      const tri = combos(12, 3).filter(([a, b, c]) => [[a, b], [b, c], [a, c]].every(([p, q]) => Math.abs(V.len(V.sub(ico[p], ico[q])) - 2) < 1e-6));
      if (sides === 20) { verts = ico; faces = tri; }
      else { verts = tri.map(t => V.norm(mean(t.map(i => ico[i])))); faces = ico.map((_, i) => tri.map((t, j) => (t.includes(i) ? j : -1)).filter(j => j >= 0)); }
    }
    const R = Math.max(...verts.map(V.len));
    verts = verts.map(p => V.mul(p, 1 / R));
    faces = faces.map(f => face(verts, f));
    const num = new Array(faces.length).fill(0), used = new Set();
    let v = 1;
    for (let i = 0; i < faces.length; i++) {
      if (used.has(i)) continue;
      const opp = faces.findIndex((f, j) => j !== i && !used.has(j) && V.dot(f.n, faces[i].n) < -0.99);
      num[i] = v; used.add(i);
      if (opp >= 0) { num[opp] = faces.length + 1 - v; used.add(opp); }
      v++;
    }
    const vnum = verts.map((_, k) => k + 1);   // d4: each corner's number (read at the top point)
    return { verts, faces, num, vnum, sides };
  }

  // ── meshes: one geometry per die type (UVs into a number atlas), one material per die type + owner ──
  const COLORS = { mine: ['#1f9a5c', '#0d4a2b'], theirs: ['#b42a40', '#5a1220'] };
  const SOLIDS = {}, GEO = {}, MAT = {};
  const solidOf = s => (SOLIDS[s] ||= solid([4, 6, 8, 10, 12, 20].includes(s) ? s : 6));
  const grid = n => { const cols = Math.ceil(Math.sqrt(n)); return { cols, rows: Math.ceil(n / cols) }; };
  function geometry(sides) {
    if (GEO[sides]) return GEO[sides];
    const S = solidOf(sides), { cols, rows } = grid(S.faces.length);
    const pos = [], nor = [], uv = [];
    S.faces.forEach((F, i) => {
      const up = V.norm(V.sub(S.verts[F.v[0]], F.c)), right = V.cross(up, F.n);
      const R = Math.max(...F.v.map(k => V.len(V.sub(S.verts[k], F.c))));
      const cu = (i % cols + 0.5) / cols, cvv = 1 - (Math.floor(i / cols) + 0.5) / rows;
      const uvOf = p => { const d = V.sub(p, F.c); return [cu + V.dot(d, right) / R * 0.46 / cols, cvv + V.dot(d, up) / R * 0.46 / rows]; };
      for (let k = 1; k < F.v.length - 1; k++) for (const vi of [F.v[0], F.v[k], F.v[k + 1]]) {
        const p = S.verts[vi]; pos.push(...p); nor.push(...F.n); uv.push(...uvOf(p));
      }
    });
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    return (GEO[sides] = { g, edges: new T.EdgesGeometry(g, 1) });
  }
  // hi: the rolled number - a one-off atlas (not cached; freed after the roll) where that face is lighter and its
  // number big and bright while the other numbers fade back, swapped in as the die lands
  function material(sides, owner, hi) {
    const key = sides + owner;
    if (!hi && MAT[key]) return MAT[key];
    const S = solidOf(sides), { cols, rows } = grid(S.faces.length), C = 256;
    const can = document.createElement('canvas'); can.width = cols * C; can.height = rows * C;
    const x = can.getContext('2d'), [base, dark] = COLORS[owner] || COLORS.mine;
    x.fillStyle = base; x.fillRect(0, 0, can.width, can.height);
    S.faces.forEach((F, i) => {
      const cx = (i % cols + 0.5) * C, cy = (Math.floor(i / cols) + 0.5) * C;
      const R = Math.max(...F.v.map(k => V.len(V.sub(S.verts[k], F.c)))), inR = V.len(V.sub(V.mul(V.add(S.verts[F.v[0]], S.verts[F.v[1]]), 0.5), F.c));
      const diam = 2 * 0.46 * C * Math.min(1, inR / R);                // the face's inscribed circle in atlas pixels
      // a faint darker rim so facets read as moulded plastic
      const top = sides !== 4 && hi && S.num[i] === hi, dim = hi && !top;
      const gr = x.createRadialGradient(cx, cy, diam * 0.2, cx, cy, C * 0.5);
      gr.addColorStop(0, top ? mix(base, '#ffffff', 0.28) : base); gr.addColorStop(1, top ? base : dark);
      x.fillStyle = gr; x.fillRect(cx - C / 2, cy - C / 2, C, C);
      // d4: a number at each corner, its top toward that corner; the result is read at the top point, where the
      // same number sits on all three faces you can see (corner k's number = S.vnum[k])
      if (sides === 4) {
        const up = V.norm(V.sub(S.verts[F.v[0]], F.c)), right = V.cross(up, F.n);
        for (const k of F.v) {
          const d = V.sub(S.verts[k], F.c), px = V.dot(d, right) / R * 0.46 * C, py = -V.dot(d, up) / R * 0.46 * C;
          const label = String(S.vnum[k]), big = hi && S.vnum[k] === hi, fs = C * (big ? 0.25 : 0.15);
          x.save();
          x.translate(cx + px * 0.52, cy + py * 0.52);
          x.rotate(Math.atan2(px, -py));
          x.font = `800 ${fs}px Rajdhani, "Segoe UI", system-ui, sans-serif`;
          x.textAlign = 'center'; x.textBaseline = 'middle'; x.lineJoin = 'round';
          x.lineWidth = fs * (big ? 0.18 : 0.12); x.strokeStyle = big ? 'rgba(0,0,0,.75)' : 'rgba(0,0,0,.45)'; x.strokeText(label, 0, fs * 0.04);
          x.fillStyle = big ? '#ffffff' : hi ? 'rgba(244,247,245,.45)' : '#f4f7f5'; x.fillText(label, 0, fs * 0.04);
          x.restore();
        }
        return;
      }
      const label = String(S.num[i]);
      let fs = diam * (top ? 0.9 : dim ? 0.62 : sides === 4 ? 0.66 : 0.78);
      const maxW = diam * (top ? 0.92 : 0.82);
      x.font = `800 ${fs}px Rajdhani, "Segoe UI", system-ui, sans-serif`;
      const w = x.measureText(label).width;
      if (w > maxW) { fs *= maxW / w; x.font = `800 ${fs}px Rajdhani, "Segoe UI", system-ui, sans-serif`; }
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.lineJoin = 'round'; x.lineWidth = fs * (top ? 0.16 : 0.12); x.strokeStyle = top ? 'rgba(0,0,0,.7)' : 'rgba(0,0,0,.45)'; x.strokeText(label, cx, cy + fs * 0.04);
      x.fillStyle = top ? '#ffffff' : dim ? 'rgba(244,247,245,.45)' : '#f4f7f5'; x.fillText(label, cx, cy + fs * 0.04);
      if (label === '6' || label === '9') { x.fillRect(cx - fs * 0.2, cy + fs * 0.45, fs * 0.4, fs * 0.07); }
    });
    const tex = new T.CanvasTexture(can);
    tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = 4;
    const out = { mat: new T.MeshPhysicalMaterial({ map: tex, roughness: 0.32, metalness: 0, clearcoat: 0.9, clearcoatRoughness: 0.18 }),
      line: new T.LineBasicMaterial({ color: dark, transparent: true, opacity: 0.55 }) };
    return hi ? out : (MAT[key] = out);
  }
  const mix = (a, b, k) => { const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); const A = p(a), B = p(b); return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * k)).join(',')})`; };
  let shadowTex = null;
  function shadowMat() {
    if (!shadowTex) {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const x = c.getContext('2d'), g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, 'rgba(0,0,0,.75)'); g.addColorStop(0.55, 'rgba(0,0,0,.3)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g; x.fillRect(0, 0, 128, 128);
      shadowTex = new T.CanvasTexture(c);
    }
    return new T.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false });
  }

  // ── scene ──
  async function load() {
    if (renderer) return true;
    if (loading) return loading;
    loading = (async () => {
      T = await import('./vendor/three/three-dice.min.js');
      cv = document.createElement('canvas');
      cv.id = 'dice3d';
      cv.style.cssText = 'position:fixed; inset:0; width:100vw; height:100vh; z-index:44; pointer-events:none';
      document.body.appendChild(cv);
      renderer = new T.WebGLRenderer({ canvas: cv, alpha: true, antialias: true, powerPreference: 'low-power' });
      renderer.setClearColor(0x000000, 0);
      renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
      scene = new T.Scene();
      camera = new T.PerspectiveCamera(28, 1, 0.1, 200);
      camera.position.set(0, 18, 6.5); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();   // rays are cast before the first render
      scene.add(new T.HemisphereLight(0xffffff, 0x1a2630, 1.3));
      const key = new T.DirectionalLight(0xffffff, 2.4); key.position.set(-3, 14, 8); scene.add(key);
      const rim = new T.DirectionalLight(0x7fe3ff, 0.7); rim.position.set(6, 4, -8); scene.add(rim);
      size();
      // compile the shaders now so the first throw doesn't hitch
      const warm = new T.Mesh(geometry(20).g, material(20, 'mine').mat);
      scene.add(warm); renderer.compile(scene, camera); scene.remove(warm);
      window.Dice3D.ok = true;
      return true;
    })().catch(e => { console.warn('3D dice unavailable:', e); window.Dice3D.ok = false; return false; });
    return loading;
  }
  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    if (renderer.getPixelRatio() !== dpr) renderer.setPixelRatio(dpr);
    const s = renderer.getSize(new T.Vector2());
    if (s.x !== innerWidth || s.y !== innerHeight) { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); camera.updateMatrixWorld(); }
  }
  // the point on the horizontal plane y = h under screen pixel (sx, sy)
  const ray = () => new T.Raycaster();
  function onPlane(sx, sy, h) {
    const r = ray();
    r.setFromCamera(new T.Vector2(sx / innerWidth * 2 - 1, -(sy / innerHeight) * 2 + 1), camera);
    const p = new T.Vector3();
    return r.ray.intersectPlane(new T.Plane(new T.Vector3(0, 1, 0), -h), p) || p.set(0, h, 0);
  }

  // the die's orientation at rest: the result face up (the d4, which rests on a face, shows its result face
  // to the camera instead), its number upright on screen, plus a little random yaw
  function landing(S, f, pos) {
    // d4: f is a corner - point it straight up (the face opposite lies flat), then turn the die so one of the
    // three faces meeting there faces the camera, give or take a little
    if (S.sides === 4) {
      const q1 = new T.Quaternion().setFromUnitVectors(new T.Vector3(...V.norm(S.verts[f])), new T.Vector3(0, 1, 0));
      const hc = new T.Vector3(camera.position.x - pos.x, 0, camera.position.z - pos.z).normalize();
      let best = null, bd = -2;
      for (const F of S.faces) if (F.v.includes(f)) {
        const n = new T.Vector3(...F.n).applyQuaternion(q1); n.y = 0; n.normalize();
        if (n.dot(hc) > bd) { bd = n.dot(hc); best = n; }
      }
      const q2 = new T.Quaternion().setFromUnitVectors(best, hc);
      const yaw = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), (Math.random() - 0.5) * 0.4);
      return yaw.multiply(q2).multiply(q1);
    }
    const F = S.faces[f];
    const toCam = camera.position.clone().sub(pos).normalize();
    const target = S.sides === 4 ? toCam : new T.Vector3(0, 1, 0);
    const camUp = new T.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const up = camUp.clone().sub(target.clone().multiplyScalar(camUp.dot(target))).normalize();
    const q1 = new T.Quaternion().setFromUnitVectors(new T.Vector3(...F.n), target);
    const u = new T.Vector3(...V.sub(S.verts[F.v[0]], F.c)).applyQuaternion(q1);
    u.sub(target.clone().multiplyScalar(u.dot(target))).normalize();
    const q2 = u.dot(up) < -0.999 ? new T.Quaternion().setFromAxisAngle(target, Math.PI) : new T.Quaternion().setFromUnitVectors(u, up);
    const yaw = new T.Quaternion().setFromAxisAngle(target, (Math.random() - 0.5) * 0.35);
    return yaw.multiply(q2).multiply(q1);
  }

  const easeOut = (t, p) => 1 - Math.pow(1 - t, p);
  function frame(now) {
    size();
    for (let i = active.length - 1; i >= 0; i--) {
      const d = active[i], t = Math.min(1, Math.max(0, (now - d.t0) / d.dur));
      if (now > d.t0 + d.dur + d.hold) { scene.remove(d.mesh, d.shadow); d.hi.mat.map.dispose(); d.hi.mat.dispose(); d.hi.line.dispose(); d.shadow.material.dispose(); active.splice(i, 1); continue; }
      if (!d.landed && t >= 0.84) { d.landed = now; d.mesh.material = d.hi.mat; }
      // height: falls in, then three hops, each lower
      let h = 0;
      if (t < d.b[0]) h = d.drop * (1 - Math.pow(t / d.b[0], 2));
      else for (let k = 0; k < 3; k++) if (t >= d.b[k] && t < d.b[k + 1]) { const s = (t - d.b[k]) / (d.b[k + 1] - d.b[k]); h = d.hop[k] * 4 * s * (1 - s); }
      const e = easeOut(t, 2.6);
      d.mesh.position.set(d.p0.x + (d.p1.x - d.p0.x) * e, d.rest + h, d.p0.z + (d.p1.z - d.p0.z) * e);
      const spin = d.spin * Math.pow(1 - Math.min(1, t / 0.9), 2.4);
      const pop = d.landed ? 1 + 0.1 * Math.max(0, 1 - (now - d.landed) / 260) * Math.sin(Math.min(1, (now - d.landed) / 260) * Math.PI) : 1;
      d.mesh.scale.setScalar(d.r * pop);
      d.mesh.quaternion.copy(d.q).multiply(new T.Quaternion().setFromAxisAngle(d.axis, spin));
      d.shadow.position.set(d.mesh.position.x + h * 0.15, 0.01, d.mesh.position.z + h * 0.1);
      const sc = d.r * 2.3 * (1 + h / d.r * 0.25);
      d.shadow.scale.set(sc, sc, 1);
      d.shadow.material.opacity = Math.max(0.15, 0.6 - h / d.r * 0.12);
    }
    renderer.render(scene, camera);
    raf = active.length ? requestAnimationFrame(frame) : 0;
  }

  // Throw one die; resolves once it has landed and sat for a beat (the board then slides it into its row).
  async function roll(sides, value, owner = 'mine', at) {
    if (!(await load())) return false;
    size();
    const S = solidOf(+sides || 6);
    let f = S.sides === 4 ? +value - 1 : S.num.indexOf(+value);   // the d4 lands on a corner, the rest on a face
    if (f < 0) f = Math.floor(Math.random() * S.faces.length);
    const tb = document.getElementById('table'), TB = (tb && !tb.hidden ? tb : document.body).getBoundingClientRect();
    const px = at?.size || Math.min(TB.width, TB.height) * 0.16;
    const sx = at ? at.x + px / 2 : TB.left + TB.width / 2, sy = at ? at.y + px / 2 : TB.top + TB.height / 2;
    // world radius so the die is about `px` pixels across where it lands
    let r = 1, p1 = onPlane(sx, sy, 0);
    for (let k = 0; k < 2; k++) {
      const dist = camera.position.distanceTo(p1), perPx = 2 * dist * Math.tan(camera.fov * Math.PI / 360) / innerHeight;
      r = px * 0.5 * perPx;
      p1 = onPlane(sx, sy, r * 0.6);
    }
    const inR = S.sides === 4 ? 1 / 3 : Math.abs(V.dot(S.faces[f].c, S.faces[f].n));   // centre height at rest
    const rest = r * inR;
    p1 = onPlane(sx, sy, rest);
    const fromMine = owner !== 'theirs';
    const p0 = onPlane(sx + (Math.random() - 0.5) * TB.width * 0.6, fromMine ? TB.bottom - px * 0.2 : TB.top + px * 0.2, rest);
    const { g, edges } = geometry(S.sides), { mat, line } = material(S.sides, owner === 'theirs' ? 'theirs' : 'mine');
    const mesh = new T.Mesh(g, mat);
    mesh.add(new T.LineSegments(edges, line));
    mesh.scale.setScalar(r);
    const shadow = new T.Mesh(new T.PlaneGeometry(1, 1), shadowMat());
    shadow.rotation.x = -Math.PI / 2;
    const j = () => 0.8 + Math.random() * 0.4;
    const b0 = 0.24 + Math.random() * 0.06;
    const d = { mesh, shadow, r, rest, p0, p1, t0: performance.now(), dur: 1050, hold: 750, hi: material(S.sides, owner === 'theirs' ? 'theirs' : 'mine', S.sides === 4 ? +value : S.num[f]), landed: 0,
      drop: r * (2.6 + Math.random()), b: [b0, b0 + 0.27, b0 + 0.45, b0 + 0.57], hop: [r * 1.15 * j(), r * 0.5 * j(), r * 0.16 * j()],
      q: landing(S, f, p1), axis: new T.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(), spin: Math.PI * (4 + Math.random() * 3) };
    // a d4 doesn't roll: it is dropped lower, tips over its edges a turn or two (spin about a level axis) and skids
    if (S.sides === 4) {
      const a = Math.random() * Math.PI * 2;
      Object.assign(d, { dur: 850, drop: r * (1.5 + Math.random() * 0.6), hop: [r * 0.55 * j(), r * 0.2 * j(), r * 0.05],
        axis: new T.Vector3(Math.cos(a), 0, Math.sin(a)), spin: Math.PI * (1.5 + Math.random()) });
    }
    scene.add(mesh, shadow);
    active.push(d);
    if (!raf) raf = requestAnimationFrame(frame);
    return new Promise(ok => setTimeout(() => ok(true), d.dur + d.hold - 60));   // never wait on paused frames
  }

  // _bench(n): ms of GPU+CPU to draw six dice n times (cost check)
  async function bench(n = 100) {
    await load(); size();
    const ms = [4, 6, 8, 10, 12, 20].map((s, i) => { const m = new T.Mesh(geometry(s).g, material(s, i % 2 ? 'theirs' : 'mine').mat); m.position.set(-5 + i * 2, 1, 0); scene.add(m); return m; });
    const gl = renderer.getContext(), t0 = performance.now();
    for (let k = 0; k < n; k++) { ms.forEach(m => m.rotation.set(k * 0.1, k * 0.07, 0)); renderer.render(scene, camera); }
    gl.finish();
    const t = (performance.now() - t0) / n;
    ms.forEach(m => scene.remove(m)); renderer.render(scene, camera);
    return t;
  }

  // _draw(): draw the dice as they are right now (testing: background tabs throttle animation frames)
  const draw = () => { if (renderer) { const keep = raf; frame(performance.now()); if (!keep && raf) { cancelAnimationFrame(raf); raf = 0; } } };
  window.Dice3D = { ok: null, load, roll, place: () => {}, _bench: bench, _draw: draw };
  addEventListener('load', () => setTimeout(() => load(), 300));
})();
