// Live top-down minimap of Marina City: the local player sits at the centre as
// an arrow facing their heading. The actual generated city is drawn — water
// bays, green parks, building footprints and the road grid — plus other players
// and monsters as dots (clamped to the rim when out of range).
const PERIOD = 16;            // city grid period (must match world.js)
const ROAD = 4;               // road width in blocks
const FOOT0 = 6, FOOT1 = 13;  // building footprint (8x8) within a cell

export class Minimap {
  constructor() {
    this.canvas = document.getElementById('minimap');
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.range = 64; // world blocks from centre to edge
    this.world = null;
  }

  draw(player, remotes, mobs) {
    const ctx = this.ctx;
    if (!ctx || !player) return;
    const W = this.canvas.width, H = this.canvas.height;
    const cx = W / 2, cy = H / 2, R = Math.min(cx, cy) - 2;
    const scale = R / this.range;
    // World → screen helpers (world x → right, world z → down).
    const sX = (wx) => cx + (wx - player.pos.x) * scale;
    const sZ = (wz) => cy + (wz - player.pos.z) * scale;

    ctx.clearRect(0, 0, W, H);

    // Circular backdrop (concrete-grey base = streets/sidewalks).
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(46,54,68,0.72)';
    ctx.fill();
    ctx.clip();

    // ---- City cells: paint each cell's contents from the live world. ----
    if (this.world) {
      const cell0x = Math.floor((player.pos.x - this.range) / PERIOD) - 1;
      const cell1x = Math.ceil((player.pos.x + this.range) / PERIOD) + 1;
      const cell0z = Math.floor((player.pos.z - this.range) / PERIOD) - 1;
      const cell1z = Math.ceil((player.pos.z + this.range) / PERIOD) + 1;
      const span = (FOOT1 - FOOT0 + 1) * scale;
      for (let ccx = cell0x; ccx <= cell1x; ccx++) {
        for (let ccz = cell0z; ccz <= cell1z; ccz++) {
          const cell = this.world.cellAt(ccx, ccz);
          const ox = ccx * PERIOD, oz = ccz * PERIOD;
          if (cell.kind === 'bay') {
            // Whole buildable area is water.
            ctx.fillStyle = 'rgba(40,96,168,0.75)';
            ctx.fillRect(sX(ox + ROAD), sZ(oz + ROAD), (PERIOD - ROAD) * scale, (PERIOD - ROAD) * scale);
          } else if (cell.kind === 'park') {
            ctx.fillStyle = 'rgba(46,128,64,0.7)';
            ctx.fillRect(sX(ox + ROAD), sZ(oz + ROAD), (PERIOD - ROAD) * scale, (PERIOD - ROAD) * scale);
            ctx.fillStyle = '#7fe3a0'; // supertree dot at the cell centre
            ctx.beginPath(); ctx.arc(sX(ox + 9.5), sZ(oz + 9.5), Math.max(1, 1.6 * scale * 2), 0, 7); ctx.fill();
          } else if (cell.kind === 'tower') {
            // Building footprint, brightness rising with height.
            const t = Math.min(1, ((cell.buildH || 10) - 6) / 15);
            const v = Math.round(120 + t * 90);
            ctx.fillStyle = `rgba(${v},${v + 8},${v + 20},0.9)`;
            ctx.fillRect(sX(ox + FOOT0), sZ(oz + FOOT0), span, span);
          } else if (cell.kind === 'plaza') {
            ctx.fillStyle = 'rgba(150,140,110,0.7)'; // marble spawn plaza
            ctx.fillRect(sX(ox + ROAD), sZ(oz + ROAD), (PERIOD - ROAD) * scale, (PERIOD - ROAD) * scale);
          }
        }
      }

      // Road grid on top (asphalt bands run along the low edge of each cell).
      ctx.fillStyle = 'rgba(24,28,36,0.85)';
      const band = ROAD * scale;
      for (let ccx = cell0x; ccx <= cell1x; ccx++) {
        ctx.fillRect(sX(ccx * PERIOD), cy - R, band, R * 2);
      }
      for (let ccz = cell0z; ccz <= cell1z; ccz++) {
        ctx.fillRect(cx - R, sZ(ccz * PERIOD), R * 2, band);
      }
    }

    // Other players. World x → right, world z → down (so −z is "up"/north).
    for (const r of remotes.values()) {
      let dx = (r.group.position.x - player.pos.x) * scale;
      let dy = (r.group.position.z - player.pos.z) * scale;
      const d = Math.hypot(dx, dy);
      let onEdge = false;
      if (d > R - 6) { const k = (R - 6) / (d || 1); dx *= k; dy *= k; onEdge = true; }
      const px = cx + dx, py = cy + dy;
      ctx.beginPath();
      ctx.arc(px, py, onEdge ? 3 : 4, 0, Math.PI * 2);
      ctx.fillStyle = onEdge ? '#f4d35e' : '#5fd0ff';
      ctx.fill();
      if (!onEdge && r.name) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(r.name.slice(0, 8), px, py - 6);
      }
    }

    // Monsters as red dots.
    if (mobs) {
      ctx.fillStyle = '#e25555';
      for (const e of mobs.values()) {
        let dx = (e.group.position.x - player.pos.x) * scale;
        let dy = (e.group.position.z - player.pos.z) * scale;
        const d = Math.hypot(dx, dy);
        if (d > R - 4) continue; // only show in-range monsters
        ctx.beginPath();
        ctx.arc(cx + dx, cy + dy, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    // Local player arrow at centre, pointing along heading.
    const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw); // forward in x,z
    const len = 8, wid = 5;
    const rx = -fz, rz = fx; // right perpendicular
    ctx.beginPath();
    ctx.moveTo(cx + fx * len, cy + fz * len);
    ctx.lineTo(cx - fx * 5 + rx * wid, cy - fz * 5 + rz * wid);
    ctx.lineTo(cx - fx * 5 - rx * wid, cy - fz * 5 - rz * wid);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    // Rim.
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}
