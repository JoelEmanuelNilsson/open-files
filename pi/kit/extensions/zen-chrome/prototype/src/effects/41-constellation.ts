/**
 * PROTOTYPE — throwaway. Nodes drift along the outline and link to their nearest
 * neighbours across the box; a signal packet hops node to node down the links.
 */

import { css, hex, lerp } from "../core/color.ts";
import { cellCentre } from "../core/render.ts";
import type { Cell, CellStyle, Effect, EffectInstance, Frame } from "../core/types.ts";

const NODE = hex("#7fd4ff");
const LINK = hex("#2f6d94");
const PACKET = hex("#eaf8ff");

interface Node {
	/** Position along the ring in cells, wrapped. */
	pos: number;
	vel: number;
	phase: number;
	cx: number;
	cy: number;
}

interface Link {
	a: number;
	b: number;
	strength: number;
}

interface Packet {
	from: number;
	to: number;
	u: number;
	life: number;
}

const effect: Effect = {
	id: "constellation",
	name: "Constellation",
	group: "signal",
	blurb: "Drifting nodes on the outline wire themselves into a HUD network; signals hop the links.",
	palette: { hot: NODE, peak: PACKET },
	params: [
		{ key: "spacing", label: "node spacing", min: 4, max: 20, step: 1, value: 8 },
		{ key: "drift", label: "drift (cells/s)", min: 0, max: 6, step: 0.1, value: 1.4 },
		{ key: "reach", label: "link reach", min: 40, max: 400, step: 5, value: 170 },
		{ key: "packets", label: "packets/s", min: 0, max: 4, step: 0.1, value: 0.9 },
	],
	create(): EffectInstance {
		let nodes: Node[] = [];
		let links: Link[] = [];
		const packets: Packet[] = [];
		let spacingUsed = -1;
		let pending = 0;

		/** ringIndex → cell, rebuilt only when the grid changes size. */
		let ringCells: Cell[] = [];
		let ringLen = -1;

		const indexRing = (f: Frame) => {
			if (ringLen === f.box.ringLength && ringCells.length === ringLen) return;
			ringLen = f.box.ringLength;
			ringCells = [];
			for (const c of f.box.cells) if (c.ringIndex >= 0) ringCells[c.ringIndex] = c;
		};

		const place = (f: Frame, n: Node) => {
			const len = f.box.ringLength;
			const i = ((Math.round(n.pos) % len) + len) % len;
			const c = ringCells[i];
			if (!c) return;
			const p = cellCentre(f, c.x, c.y);
			n.cx = p.cx;
			n.cy = p.cy;
		};

		return {
			update(f: Frame) {
				indexRing(f);
				const spacing = f.params.spacing ?? 8;
				if (spacing !== spacingUsed || nodes.length === 0) {
					spacingUsed = spacing;
					const count = Math.max(4, Math.round(f.box.ringLength / spacing));
					nodes = [];
					for (let i = 0; i < count; i++) {
						nodes.push({
							pos: (i + Math.random() * 0.6) * (f.box.ringLength / count),
							vel: (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random()),
							phase: Math.random() * Math.PI * 2,
							cx: 0,
							cy: 0,
						});
					}
					packets.length = 0;
				}

				const drift = f.working ? (f.params.drift ?? 1.4) : 0;
				for (const n of nodes) {
					n.pos = (n.pos + n.vel * drift * f.dt + f.box.ringLength) % f.box.ringLength;
					n.phase += f.dt * (1.2 + n.vel * 0.4);
					place(f, n);
				}

				const reach = f.params.reach ?? 170;
				links = [];
				for (let i = 0; i < nodes.length; i++) {
					const a = nodes[i] as Node;
					const near: Array<{ j: number; d: number }> = [];
					for (let j = 0; j < nodes.length; j++) {
						if (j === i) continue;
						const b = nodes[j] as Node;
						const d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
						if (d < reach) near.push({ j, d });
					}
					near.sort((p, q) => p.d - q.d);
					for (const { j, d } of near.slice(0, 2)) {
						if (j < i) continue;
						links.push({ a: i, b: j, strength: (1 - d / reach) ** 1.4 });
					}
				}

				pending += (f.working ? (f.params.packets ?? 0.9) * f.intensity : 0) * f.dt;
				while (pending >= 1 && links.length > 0) {
					pending -= 1;
					const l = links[Math.floor(Math.random() * links.length)] as Link;
					packets.push({ from: l.a, to: l.b, u: 0, life: 0 });
				}
				for (let i = packets.length - 1; i >= 0; i--) {
					const p = packets[i] as Packet;
					p.u += f.dt * 1.6;
					p.life += f.dt;
					if (p.u >= 1) {
						const onward = links.filter((l) => l.a === p.to || l.b === p.to);
						const next = onward[Math.floor(Math.random() * onward.length)];
						if (!next || p.life > 3.5) {
							packets.splice(i, 1);
							continue;
						}
						p.from = p.to;
						p.to = next.a === p.from ? next.b : next.a;
						p.u = 0;
					}
				}
			},

			cell(cell: Cell, f: Frame): CellStyle | null {
				if (cell.ringIndex < 0) return null;
				const len = f.box.ringLength;
				let level = 0;
				for (const n of nodes) {
					let d = Math.abs(cell.ringIndex - n.pos);
					if (d > len / 2) d = len - d;
					if (d > 2.2) continue;
					const pulse = 0.6 + 0.4 * Math.sin(n.phase);
					level = Math.max(level, Math.exp(-d * d * 0.9) * (f.working ? pulse : 0.35));
				}
				level *= f.intensity;
				if (level < 0.03) return null;
				return {
					color: lerp(cell.color, level > 0.75 ? PACKET : NODE, Math.min(1, level * 1.4)),
					glow: level * 9,
					scale: 1 + level * 0.12,
				};
			},

			drawOver(g: CanvasRenderingContext2D, f: Frame) {
				g.globalCompositeOperation = "lighter";
				g.lineWidth = 1;
				const gain = (f.working ? 1 : 0.35) * f.intensity;
				for (const l of links) {
					const a = nodes[l.a];
					const b = nodes[l.b];
					if (!a || !b) continue;
					const grad = g.createLinearGradient(a.cx, a.cy, b.cx, b.cy);
					const alpha = l.strength * 0.32 * gain;
					grad.addColorStop(0, css(NODE, alpha));
					grad.addColorStop(0.5, css(LINK, alpha * 0.55));
					grad.addColorStop(1, css(NODE, alpha));
					g.strokeStyle = grad;
					g.beginPath();
					g.moveTo(a.cx, a.cy);
					g.lineTo(b.cx, b.cy);
					g.stroke();
				}

				for (const p of packets) {
					const a = nodes[p.from];
					const b = nodes[p.to];
					if (!a || !b) continue;
					const x = a.cx + (b.cx - a.cx) * p.u;
					const y = a.cy + (b.cy - a.cy) * p.u;
					g.strokeStyle = css(PACKET, 0.5 * f.intensity);
					g.lineWidth = 1.4;
					g.beginPath();
					g.moveTo(a.cx + (b.cx - a.cx) * Math.max(0, p.u - 0.22), a.cy + (b.cy - a.cy) * Math.max(0, p.u - 0.22));
					g.lineTo(x, y);
					g.stroke();
					g.fillStyle = css(PACKET, 0.9 * f.intensity);
					g.shadowBlur = 8;
					g.shadowColor = css(NODE, 0.9);
					g.beginPath();
					g.arc(x, y, 1.9, 0, Math.PI * 2);
					g.fill();
					g.shadowBlur = 0;
				}
			},
		};
	},
};

export default effect;
