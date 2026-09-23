/** PROTOTYPE — throwaway. Contact sheet of every working-state effect; click one to focus it. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatBar } from "./core/ChatBar.tsx";
import { DEFAULT_LABELS } from "./core/geometry.ts";
import { DEFAULT_THEME, THEMES } from "./core/palettes.ts";
import { defaultParams, EFFECTS, effectById } from "./core/registry.ts";
import type { Effect, Palette } from "./core/types.ts";

const SHEET_COLS = 74;
const SHEET_SIZE = 9;
const FOCUS_COLS = 118;
const FOCUS_SIZE = 15;
const ROWS = 3;

interface Settings {
	themeId: string;
	forceTheme: boolean;
	working: boolean;
	speed: number;
	intensity: number;
	bloom: number;
	input: string;
}

const INITIAL: Settings = {
	themeId: DEFAULT_THEME.id,
	forceTheme: false,
	working: true,
	speed: 1,
	intensity: 1,
	bloom: 0,
	input: "",
};

function paletteFor(effect: Effect, base: Palette, force: boolean): Palette {
	return force || !effect.palette ? base : { ...base, ...effect.palette };
}

function useSearchParam(key: string): [string | null, (value: string | null) => void] {
	const [value, setValue] = useState<string | null>(() => new URLSearchParams(window.location.search).get(key));
	useEffect(() => {
		const onPop = () => setValue(new URLSearchParams(window.location.search).get(key));
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, [key]);
	const set = useCallback(
		(next: string | null) => {
			const params = new URLSearchParams(window.location.search);
			if (next === null) params.delete(key);
			else params.set(key, next);
			const query = params.toString();
			window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
			setValue(next);
		},
		[key],
	);
	return [value, set];
}

export function App() {
	const [variant, setVariant] = useSearchParam("variant");
	const [group, setGroup] = useSearchParam("group");
	const [settings, setSettings] = useState<Settings>(INITIAL);
	const [params, setParams] = useState<Record<string, Record<string, number>>>({});

	const theme = THEMES.find((t) => t.id === settings.themeId) ?? DEFAULT_THEME;
	const focused = variant ? effectById(variant) : null;

	const paramsFor = useCallback(
		(effect: Effect) => params[effect.id] ?? defaultParams(effect),
		[params],
	);

	const setParam = (effect: Effect, key: string, value: number) =>
		setParams((prev) => ({ ...prev, [effect.id]: { ...(prev[effect.id] ?? defaultParams(effect)), [key]: value } }));

	const labels = useMemo(() => ({ ...DEFAULT_LABELS, input: settings.input }), [settings.input]);

	// Filtering the sheet to one family is how a dozen siblings get compared.
	const groups = useMemo(() => [...new Set(EFFECTS.map((e) => e.group))], []);
	const visible = useMemo(() => (group ? EFFECTS.filter((e) => e.group === group) : EFFECTS), [group]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement | null;
			if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
			if (e.key === "Escape") return setVariant(null);
			if (e.key === " ") {
				e.preventDefault();
				return setSettings((s) => ({ ...s, working: !s.working }));
			}
			if (!focused || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
			const ring = visible.some((x) => x.id === focused.id) ? visible : EFFECTS;
			const index = ring.findIndex((x) => x.id === focused.id);
			const next = (index + (e.key === "ArrowRight" ? 1 : -1) + ring.length) % ring.length;
			setVariant((ring[next] as Effect).id);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [focused, setVariant, visible]);

	const shared = {
		working: settings.working,
		speed: settings.speed,
		intensity: settings.intensity,
		bloom: settings.bloom,
		rows: ROWS,
		labels,
	};

	return (
		<div style={{ minHeight: "100vh", background: theme.backdrop, color: "#c7d2e0", fontFamily: "ui-sans-serif,system-ui" }}>
			<div style={{ padding: "28px 32px 140px" }}>
				<header style={{ marginBottom: 24 }}>
					<h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: -0.2 }}>
						zen-chrome · working-state effects
					</h1>
					<p style={{ margin: "6px 0 0", fontSize: 13, opacity: 0.6 }}>
						{focused
							? `${focused.name} — ${focused.blurb}  ·  ← → to cycle, Esc for the sheet, Space toggles working`
							: `${visible.length} variants, all live. Click one to focus. Space toggles the working state.`}
					</p>
					{!focused && (
						<div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
							{[null, ...groups].map((id) => (
								<button
									key={id ?? "all"}
									type="button"
									onClick={() => setGroup(id)}
									style={{
										all: "unset",
										cursor: "pointer",
										fontSize: 11,
										padding: "4px 10px",
										borderRadius: 999,
										border: "1px solid rgba(255,255,255,0.12)",
										background: (group ?? null) === id ? "rgba(255,255,255,0.14)" : "transparent",
										opacity: (group ?? null) === id ? 1 : 0.55,
									}}
								>
									{id ?? "all"}
								</button>
							))}
						</div>
					)}
				</header>

				{focused ? (
					<div style={{ display: "flex", justifyContent: "center", padding: "40px 0" }}>
						<ChatBar
							{...shared}
							effect={focused}
							palette={paletteFor(focused, theme.palette, settings.forceTheme)}
							cols={FOCUS_COLS}
							size={FOCUS_SIZE}
							params={paramsFor(focused)}
							fps={60}
						/>
					</div>
				) : (
					<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(520px,1fr))", gap: 18 }}>
						{visible.map((effect) => (
							<button
								key={effect.id}
								type="button"
								onClick={() => setVariant(effect.id)}
								style={{
									all: "unset",
									cursor: "pointer",
									border: "1px solid rgba(255,255,255,0.07)",
									borderRadius: 10,
									padding: 12,
									background: "rgba(255,255,255,0.015)",
								}}
							>
								<div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 12 }}>
									<span style={{ fontWeight: 600 }}>{effect.name}</span>
									<span style={{ opacity: 0.4 }}>{effect.group}</span>
								</div>
								<ChatBar
									{...shared}
									effect={effect}
									palette={paletteFor(effect, theme.palette, settings.forceTheme)}
									cols={SHEET_COLS}
									size={SHEET_SIZE}
									params={paramsFor(effect)}
									fps={30}
								/>
								<div style={{ marginTop: 8, fontSize: 11, opacity: 0.45, lineHeight: 1.4 }}>{effect.blurb}</div>
							</button>
						))}
					</div>
				)}
			</div>

			<Controls
				settings={settings}
				setSettings={setSettings}
				focused={focused}
				params={focused ? paramsFor(focused) : {}}
				setParam={setParam}
				onBack={() => setVariant(null)}
			/>
		</div>
	);
}

interface ControlsProps {
	settings: Settings;
	setSettings: (fn: (s: Settings) => Settings) => void;
	focused: Effect | null;
	params: Record<string, number>;
	setParam: (effect: Effect, key: string, value: number) => void;
	onBack: () => void;
}

function Controls({ settings, setSettings, focused, params, setParam, onBack }: ControlsProps) {
	return (
		<div
			style={{
				position: "fixed",
				left: 0,
				right: 0,
				bottom: 0,
				padding: "10px 16px",
				display: "flex",
				gap: 18,
				alignItems: "center",
				flexWrap: "wrap",
				background: "rgba(8,11,16,0.86)",
				backdropFilter: "blur(12px)",
				borderTop: "1px solid rgba(255,255,255,0.08)",
				fontSize: 12,
			}}
		>
			{focused && (
				<button type="button" onClick={onBack} style={buttonStyle}>
					← all {EFFECTS.length}
				</button>
			)}
			<button type="button" onClick={() => setSettings((s) => ({ ...s, working: !s.working }))} style={buttonStyle}>
				{settings.working ? "■ working" : "▶ idle"}
			</button>
			<Slider label="speed" value={settings.speed} min={0} max={3} step={0.05} onChange={(v) => setSettings((s) => ({ ...s, speed: v }))} />
			<Slider label="intensity" value={settings.intensity} min={0} max={1.5} step={0.05} onChange={(v) => setSettings((s) => ({ ...s, intensity: v }))} />
			<Slider label="bloom" value={settings.bloom} min={0} max={20} step={0.5} onChange={(v) => setSettings((s) => ({ ...s, bloom: v }))} />
			<label style={labelStyle}>
				theme
				<select
					value={settings.themeId}
					onChange={(e) => setSettings((s) => ({ ...s, themeId: e.target.value }))}
					style={{ ...inputStyle, padding: "3px 6px" }}
				>
					{THEMES.map((t) => (
						<option key={t.id} value={t.id}>
							{t.name}
						</option>
					))}
				</select>
			</label>
			<label style={labelStyle}>
				<input
					type="checkbox"
					checked={settings.forceTheme}
					onChange={(e) => setSettings((s) => ({ ...s, forceTheme: e.target.checked }))}
				/>
				force theme colours
			</label>
			<label style={labelStyle}>
				input
				<input
					value={settings.input}
					onChange={(e) => setSettings((s) => ({ ...s, input: e.target.value }))}
					placeholder="type into the bar"
					style={{ ...inputStyle, width: 160 }}
				/>
			</label>
			{focused?.params?.map((spec) => (
				<Slider
					key={spec.key}
					label={spec.label}
					value={params[spec.key] ?? spec.value}
					min={spec.min}
					max={spec.max}
					step={spec.step}
					onChange={(v) => setParam(focused, spec.key, v)}
				/>
			))}
		</div>
	);
}

const buttonStyle: React.CSSProperties = {
	all: "unset",
	cursor: "pointer",
	padding: "4px 10px",
	borderRadius: 6,
	background: "rgba(255,255,255,0.08)",
	fontSize: 12,
};

const labelStyle: React.CSSProperties = { display: "flex", gap: 6, alignItems: "center", opacity: 0.85 };

const inputStyle: React.CSSProperties = {
	background: "rgba(255,255,255,0.06)",
	border: "1px solid rgba(255,255,255,0.1)",
	borderRadius: 5,
	color: "inherit",
	padding: "3px 6px",
	fontSize: 12,
};

function Slider(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
	return (
		<label style={labelStyle}>
			{props.label}
			<input
				type="range"
				min={props.min}
				max={props.max}
				step={props.step}
				value={props.value}
				onChange={(e) => props.onChange(Number(e.target.value))}
				style={{ width: 88 }}
			/>
			<span style={{ opacity: 0.5, width: 34, fontVariantNumeric: "tabular-nums" }}>{props.value}</span>
		</label>
	);
}
