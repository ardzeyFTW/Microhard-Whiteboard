import type { Background, BoardDoc, Bounds, Camera, El, Handle, LineEl, Pt, ShapeEl, ShapeKind, StrokeEl } from '../types';
import {
  boundsOf, clipSegment, cutPolyline, eraseHit, hitTest, inLasso, normRect, rectContains, rectInside, rectsIntersect, resizeBounds, rotateEl, rotatePt, rotationOf, transformEl, translateEl,
  unionBounds,
} from '../geometry';
import { ImageCache, drawBackground, drawElement, drawElements, makeThumbnail, renderBoard, type DrawOpts } from '../render';
import { recognizeShape } from '../ink';
import { filterPoint } from '../inkFilter';
import { BoardSync, type RemoteChange } from '../sync/boardSync';
import { CursorTrack, type Trail } from '../sync/cursorTrack';
import { followAfterUser, followTarget, stepFollow, type FollowDisturbance, type FollowMode } from './followView';
import { saveBoard } from '../db';
import { clamp, isTypingTarget, tint, uid } from '../util';
import { FONT_FAMILY, LINE_HEIGHT, NOTE_PAD, NOTE_TEXT_COLOR, fitNote, fitTextBox } from '../text';
import { createNote, createText, referencedAssets, sanitizeAssets, sanitizeElements } from '../model';
import { buildTemplate, type TemplateId } from '../templates';
import { prepareImage, type ImageQuality } from '../image';
import { isPdfFile } from '../pdf';
import { layoutPages, type StackOptions } from '../pdfLayout';
import { HIGHLIGHT_COLORS, NOTE_COLORS, PEN_MAX_SIZE } from '../palette';
import { readPrefs, writePrefs } from '../prefs';
import { LIMITS, getUsage, type Usage } from '../limits';
import { isElectron } from '../version';
import { estimateDocBytes } from '../storageFormat';

export type LimitEvent =
  | { kind: 'boardFull' }
  | { kind: 'boardAlmostFull'; bytes: number }
  | { kind: 'storageFull'; usage: Usage };

export interface EditorOptions {
  /** Saved Yjs document to start from, for a board that has been shared. */
  ystate?: Uint8Array;
  /** A board someone else shared: it isn't saved to this device's board list. */
  guest?: boolean;
  /** Called with the Yjs document on every save, when it needs keeping (shared boards and guest copies). */
  saveYState?: (state: Uint8Array) => Promise<void>;
  /**
   * Beside another board (a viewer's own board next to the shared one), both editors hear every key
   * press and copy/paste on the page. These say whether this one should act on it.
   */
  acceptKey?: (e: KeyboardEvent) => boolean;
  acceptClipboard?: (kind: 'copy' | 'cut' | 'paste') => boolean;
  /** Asked before each save: say no to keep a board that was never touched out of the board list. */
  shouldSave?: () => boolean;
}

/** What this person is doing, for others on a shared board to see. */
export interface LocalPresence {
  cursor: Pt | null;
  selection: string[];
  editing: string | null;
  /** The stroke being drawn right now. */
  stroke: LiveStroke | null;
  /** The tool in hand, shown at the cursor. Null when just selecting or panning. */
  tool: ToolInHand | null;
  /** The part of the board on screen, in board coordinates. Only the owner sends it, so viewers can follow. */
  view?: Bounds | null;
}

/** What others see at someone's cursor. `color` is the ink for pens and highlighters. */
export type ToolInHand =
  | { kind: 'pen' | 'highlighter'; color: string }
  | { kind: 'eraser'; mode: EraserMode }
  | { kind: 'lasso' | 'shape' };

export interface LiveStroke {
  points: number[];
  color: string;
  size: number;
  highlighter: boolean;
  opacity?: number;
}

/** Someone else on a shared board, as drawn on this screen. */
export interface RemotePerson extends LocalPresence {
  id: number;
  name: string;
  color: string;
  /** Their recent pointer positions, newest update marked by `seq`. Absent from older versions of the app. */
  trail?: (Trail & { seq: number }) | null;
  /** The board's owner (the one a viewer follows). */
  isHost?: boolean;
}

export type Tool = 'select' | 'hand' | 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'shape';
export type InkTool = 'pen' | 'highlighter' | 'eraser' | 'lasso';
export const isInkTool = (t: Tool): t is InkTool => t === 'pen' || t === 'highlighter' || t === 'eraser' || t === 'lasso';
export type ShapeTool = ShapeKind | 'line' | 'arrow';
export const SHAPE_TOOLS: ShapeTool[] = ['rect', 'ellipse', 'triangle', 'diamond', 'line', 'arrow'];

export type KeyAction =
  | 'select' | 'hand' | 'pen' | 'pen1' | 'pen2' | 'pen3' | 'highlighter' | 'eraser' | 'lasso' | 'shape' | 'note' | 'text';

export const KEY_ACTIONS: { id: KeyAction; label: string }[] = [
  { id: 'select', label: 'Select' },
  { id: 'hand', label: 'Pan (hand)' },
  { id: 'pen', label: 'Pen (next pen)' },
  { id: 'pen1', label: 'Pen 1' },
  { id: 'pen2', label: 'Pen 2' },
  { id: 'pen3', label: 'Pen 3' },
  { id: 'highlighter', label: 'Highlighter' },
  { id: 'eraser', label: 'Eraser' },
  { id: 'lasso', label: 'Lasso select' },
  { id: 'shape', label: 'Shapes' },
  { id: 'note', label: 'New sticky note' },
  { id: 'text', label: 'New text' },
];

export const DEFAULT_KEYS: Record<KeyAction, string> = {
  select: 'v', hand: 'g', pen: 'p', pen1: '1', pen2: '2', pen3: '3',
  highlighter: 'h', eraser: 'e', lasso: 'l', shape: 's', note: 'n', text: 't',
};

/** Keys the editor uses for fixed actions, which can't be rebound. */
export const RESERVED_KEYS = new Set([
  ' ', 'escape', 'enter', 'tab', 'delete', 'backspace', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', '?',
  'shift', 'control', 'alt', 'meta', 'capslock', 'contextmenu',
]);

export const normalizeKey = (key: string) => key.toLowerCase();

export const keyLabel = (key: string) => {
  if (!key) return '—';
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
};

export type LineEnds = 'none' | 'end' | 'both';

export interface PenSettings {
  color: string;
  size: number;
  /** 0.05 – 1 */
  opacity: number;
  ends: LineEnds;
}

export interface HighlighterSettings {
  color: string;
  size: number;
  opacity: number;
}

/** 'stroke' removes whole strokes it touches; 'area' is a square that only rubs out the ink under it. */
export type EraserMode = 'stroke' | 'area';

export interface EraserSettings {
  mode: EraserMode;
  /** On-screen width in pixels, before any growth from moving fast. */
  size: number;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** A round cursor of the given on-screen diameter, outlined so it shows on any background. */
function circleCursor(diameter: number, color: string, opacity: number): string {
  // Browsers ignore cursor images over 128px; an even size keeps the hotspot exactly centered.
  const d = Math.max(4, Math.min(120, Math.round(diameter / 2) * 2));
  const size = d + 4;
  const c = size / 2;
  const fill = HEX.test(color) ? color : '#000000';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<circle cx="${c}" cy="${c}" r="${d / 2}" fill="${fill}" fill-opacity="${opacity}" stroke="#ffffff" stroke-width="1"/>` +
    `<circle cx="${c}" cy="${c}" r="${d / 2 + 1}" fill="none" stroke="#000000" stroke-opacity="0.55" stroke-width="1"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${c} ${c}, crosshair`;
}

/** A square cursor of the given on-screen side, for the area eraser. */
function squareCursor(side: number): string {
  const d = Math.max(4, Math.min(120, Math.round(side / 2) * 2));
  const size = d + 4;
  const c = size / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<rect x="2" y="2" width="${d}" height="${d}" fill="#ffffff" fill-opacity="0.6" stroke="#ffffff" stroke-width="1"/>` +
    `<rect x="1" y="1" width="${d + 2}" height="${d + 2}" fill="none" stroke="#000000" stroke-opacity="0.55" stroke-width="1"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${c} ${c}, crosshair`;
}

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HANDLE_DEGREES: Record<Handle, number> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };

/** The resize arrow for a handle, following the way the selection box is turned. */
function resizeCursor(handle: Handle, angle: number): string {
  const step = Math.round((HANDLE_DEGREES[handle] + (angle * 180) / Math.PI) / 45);
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][((step % 4) + 4) % 4];
}

type Corner = 'nw' | 'ne' | 'se' | 'sw';
/** How far from a selection's corner (on the outside) grabbing it turns the selection instead of doing nothing. */
const ROTATE_ZONE = 30;

/** A turning arrow for the mouse pointer, bent around the given corner of a selection. */
const rotateCursors = new Map<number, string>();
function rotateCursor(corner: Corner, angle: number): string {
  const turns = (((Math.round({ nw: 0, ne: 90, se: 180, sw: 270 }[corner] + (angle * 180) / Math.PI)) % 360) + 360) % 360;
  let cursor = rotateCursors.get(turns);
  if (cursor) return cursor;
  const shape = 'M7 17A10 10 0 0 1 17 7M3 16h8l-4 5zM16 3v8l5-4z';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><g transform="rotate(${turns} 12 12)" stroke-linejoin="round">` +
    `<path d="${shape}" fill="#ffffff" stroke="#ffffff" stroke-width="4"/>` +
    `<path d="${shape}" fill="#000000" stroke="#000000" stroke-width="1.5"/>` +
    `<path d="M7 17A10 10 0 0 1 17 7" fill="none" stroke="#000000" stroke-width="2"/></g></svg>`;
  cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, grab`;
  rotateCursors.set(turns, cursor);
  return cursor;
}

/**
 * The turned box drawn around a selection that has just been rotated, so it can be turned and resized as it looks.
 * It only lasts while the same, unchanged elements stay selected: deselect and it's the plain box again.
 */
interface SelFrame {
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number;
  /** The selected elements as the frame left them; if they've changed since, the frame no longer fits. */
  els: El[];
}

type Interaction =
  | { kind: 'pan'; sx: number; sy: number; cam: Camera }
  | { kind: 'pinch'; dist: number; mid: Pt; cam: Camera }
  // `raw` is the freehand path (lightly smoothed); `el` is what's shown (a straight line once Shift has been pressed).
  // `last` is the latest pointer position before smoothing. `snap` is true only while Shift is held.
  | { kind: 'draw'; el: StrokeEl; raw: number[]; last: Pt; dynamic: boolean; straight: boolean; snap: boolean }
  // `size` is the eraser's current on-screen size, which grows with `speed` (screen px per ms).
  | { kind: 'erase'; erased: boolean; last: Pt; sp: Pt; t: number; speed: number; size: number }
  | { kind: 'lasso'; pts: Pt[]; base: Set<string> }
  | { kind: 'marquee'; start: Pt; cur: Pt; base: Set<string> }
  | { kind: 'move'; start: Pt; sx: number; sy: number; originals: El[]; moved: boolean; clickId: string | null; frame: SelFrame | null }
  // With a turned `frame`, `from` and `locals` are in the frame's own, upright space: the elements turned back by its angle.
  | { kind: 'resize'; handle: Handle; from: Bounds; originals: El[]; locals: El[]; frame: SelFrame | null; changed: boolean }
  // `frame` is the box when the turn began, which it turns about its center; `start` is the pointer's angle around that then.
  | { kind: 'rotate'; corner: Corner; frame: SelFrame; start: number; angle: number; originals: El[]; changed: boolean }
  | { kind: 'create'; id: string; start: Pt; el: ShapeEl | LineEl | null };

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 3.5;
const HANDLE_SIZE = 8;
// Moving the eraser fast grows it, up to this many times its set size.
const ERASER_MAX_GROWTH = 3;
const ERASER_SLOW_SPEED = 0.5;
const ERASER_FAST_SPEED = 2;
const ACCENT = '#2f6fde';
/** Someone else's cursor stays this long after it goes away (e.g. a finger lifted), then fades out. */
const CURSOR_LINGER_MS = 1500;
const CURSOR_FADE_MS = 400;
const CLIP_MARK = 'megahard-clipboard:';
const TOOLS: Tool[] = ['select', 'hand', 'pen', 'highlighter', 'eraser', 'lasso', 'shape'];

export class Editor {
  readonly doc: BoardDoc;
  readonly host: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  cam: Camera;
  tool: Tool = 'pen';
  lastInkTool: InkTool = 'pen';
  penIndex = 0;
  pens: PenSettings[] = [
    { color: '#1f1f1f', size: 4, opacity: 1, ends: 'none' },
    { color: '#e5484d', size: 4, opacity: 1, ends: 'none' },
    { color: '#0090ff', size: 4, opacity: 1, ends: 'none' },
  ];
  highlighter: HighlighterSettings = { color: HIGHLIGHT_COLORS[0], size: 22, opacity: 0.4 };
  eraser: EraserSettings = { mode: 'stroke', size: 20 };
  /** Last color picked with the custom color picker, offered again in the color menus. */
  customColor: string | null = null;
  shapeKind: ShapeTool = 'rect';
  noteColor = NOTE_COLORS[0];
  inkToShape = false;
  /** Vary line thickness with stylus pressure, or with drawing speed for mouse and touch. */
  dynamicInk = true;
  imageQuality: ImageQuality = 'standard';
  keys: Record<KeyAction, string> = { ...DEFAULT_KEYS };
  selection = new Set<string>();
  onError: (message: string) => void = (m) => console.error(m);
  /** Called when a size limit blocks something, or a board is getting close to its limit. */
  onLimit: (event: LimitEvent) => void = () => undefined;
  /** View only: pan and zoom, nothing else. */
  readOnly = false;
  /**
   * View only, but with the select tool in hand things can be picked out and copied (not moved,
   * changed or deleted). A viewer uses this on the shared board.
   */
  copyOnly = false;
  /** Called when the person's own panning or picking something ends following the owner (zooming only loosens it). */
  onFollowEnd: (() => void) | null = null;
  /** Whether this view follows where the owner of the shared board is looking (see followView.ts). */
  followMode: FollowMode = 'off';
  private hostView: Bounds | null = null;
  private snapFollow = false;
  private lastFollowFrame = 0;
  /**
   * On a shared board, new images are uploaded before they're added, so others can see them.
   * Resolves false if they can't be added.
   */
  beforeNewAssets: ((assets: Record<string, string>) => Promise<boolean>) | null = null;
  /** Called with a PDF that was dropped or pasted on the board, so the page can ask which pages to import. */
  onPdf: ((file: File) => void) | null = null;
  /** On a shared board: told whenever the cursor, selection, text being edited or stroke being drawn changes. */
  onPresence: ((p: LocalPresence) => void) | null = null;
  private remote: RemotePerson[] = [];
  private pointerInside = false;
  /**
   * Smoothing for what other people do. Their updates arrive a few times a second and unevenly,
   * so cursors glide, live strokes draw out, and things they drag slide, instead of jumping.
   */
  private smooth = {
    lastFrame: 0,
    /** Cursor shown for each person. `goneAt` is when their real cursor went away (it lingers, then fades). */
    cursors: new Map<number, { x: number; y: number; goneAt: number | null }>(),
    /** Recent pointer positions of each person, played back a moment late so the motion is continuous. */
    tracks: new Map<number, { track: CursorTrack; seq: number }>(),
    /** A wake-up for when a lingering cursor should start fading. */
    fadeTimer: 0,
    /** How many points of each person's live stroke are shown so far (`first` identifies the stroke). */
    strokes: new Map<number, { first: string; shown: number }>(),
    /** How far each element is still drawn from where it really is, shrinking to nothing. */
    offsets: new Map<string, { dx: number; dy: number }>(),
  };

  /** The board's Yjs document: tracks changes for undo, and for live sharing. */
  readonly sync: BoardSync;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly images: ImageCache;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private state: Interaction | null = null;
  private turned: SelFrame | null = null;
  private pointers = new Map<number, Pt>();
  private editing: { id: string; ta: HTMLTextAreaElement } | null = null;
  private frame = 0;
  private spaceDown = false;
  private cursorKey = '';
  private lastPointerWorld: Pt | null = null;
  private saveTimer = 0;
  private savePending = false;
  private lastThumb = 0;
  private warnedBig = false;
  private destroyed = false;
  private changeListeners = new Set<() => void>();
  private renderListeners = new Set<() => void>();
  private disposers: (() => void)[] = [];
  private resizeObserver: ResizeObserver;
  private readonly opts: EditorOptions;

  constructor(host: HTMLElement, doc: BoardDoc, opts: EditorOptions = {}) {
    this.host = host;
    this.doc = doc;
    this.opts = opts;
    this.cam = { ...doc.camera };
    this.loadPrefs();
    this.sync = new BoardSync(doc, opts.ystate);
    if (opts.ystate) {
      // The shared document is the latest version: it may have changes this device hasn't saved yet.
      doc.elements = this.sync.elements;
      doc.name = this.sync.name ?? doc.name;
      doc.background = this.sync.background ?? doc.background;
    }
    this.sync.onExternalChange((change) => this.applyExternalChange(change));
    // Drop images that nothing references any more.
    doc.assets = referencedAssets(doc.elements, doc.assets);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'wb-canvas';
    this.canvas.setAttribute('aria-label', 'Whiteboard canvas');
    host.append(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not supported in this browser');
    this.ctx = ctx;
    this.images = new ImageCache(() => this.requestRender());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    if (!doc.elements.length) this.cam = { x: -this.width / 2, y: -this.height / 2, zoom: 1 };

    const c = this.canvas;
    this.listen(c, 'pointerdown', (e: PointerEvent) => this.onPointerDown(e));
    this.listen(c, 'pointermove', (e: PointerEvent) => this.onPointerMove(e));
    this.listen(c, 'pointerenter', () => (this.pointerInside = true));
    this.listen(c, 'pointerleave', () => {
      this.pointerInside = false;
      this.reportPresence();
    });
    this.listen(c, 'pointerup', (e: PointerEvent) => this.onPointerUp(e));
    this.listen(c, 'pointercancel', (e: PointerEvent) => this.onPointerUp(e));
    this.listen(c, 'wheel', (e: WheelEvent) => this.onWheel(e), { passive: false });
    this.listen(c, 'dblclick', (e: MouseEvent) => this.onDblClick(e));
    this.listen(c, 'contextmenu', (e: Event) => e.preventDefault());
    this.listen(window, 'keydown', (e: KeyboardEvent) => this.onKeyDown(e));
    this.listen(window, 'keyup', (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        this.updateStrokeShape(false);
        if (this.state?.kind === 'resize' && this.lastPointerWorld) {
          this.applyResize(this.state, this.lastPointerWorld, false, e.altKey);
        }
        this.updateCreateShape(false, e.altKey);
      }
      if (e.key === 'Alt') {
        if (this.state?.kind === 'resize') {
          e.preventDefault();
          if (this.lastPointerWorld) {
            this.applyResize(this.state, this.lastPointerWorld, e.shiftKey, false);
          }
        } else if (this.state?.kind === 'create') {
          e.preventDefault();
          this.updateCreateShape(e.shiftKey, false);
        }
      }
      if (e.key === ' ') {
        this.spaceDown = false;
        this.updateCursor();
      }
    });
    this.listen(window, 'blur', () => {
      this.spaceDown = false;
      // Any release while away won't be seen, so finish an in-progress gesture now.
      if (this.state && this.state.kind !== 'pinch') {
        this.pointers.clear();
        this.onPointerUp(new PointerEvent('pointerup'));
      }
      this.updateCursor();
    });
    this.listen(document, 'copy', (e: ClipboardEvent) => this.onCopy(e, false));
    this.listen(document, 'cut', (e: ClipboardEvent) => this.onCopy(e, true));
    this.listen(document, 'paste', (e: ClipboardEvent) => this.onPaste(e));
    this.listen(host, 'dragover', (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    this.listen(host, 'drop', (e: DragEvent) => this.onDrop(e));
    this.listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flushSave(true);
    });
    this.listen(window, 'pagehide', () => void this.flushSave(true));

    this.updateCursor();
  }

  // ---------------------------------------------------------------- lifecycle

  private listen<E extends Event>(target: EventTarget, type: string, fn: (e: E) => void, opts?: AddEventListenerOptions) {
    const handler = fn as EventListener;
    target.addEventListener(type, handler, opts);
    this.disposers.push(() => target.removeEventListener(type, handler, opts));
  }

  async destroy() {
    if (this.destroyed) return;
    this.finishEdit();
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.smooth.fadeTimer);
    this.resizeObserver.disconnect();
    this.disposers.forEach((d) => d());
    await this.flushSave(true);
    this.canvas.remove();
  }

  onChange(fn: () => void) {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  onRender(fn: () => void) {
    this.renderListeners.add(fn);
    return () => this.renderListeners.delete(fn);
  }

  private emitChange() {
    this.changeListeners.forEach((fn) => fn());
    this.reportPresence();
  }

  // ---------------------------------------------------------------- presence (shared boards)

  private reportPresence() {
    if (!this.onPresence) return;
    const st = this.state;
    const stroke = st?.kind === 'draw'
      ? { points: st.el.points, color: st.el.color, size: st.el.size, highlighter: !!st.el.highlighter, opacity: st.el.opacity }
      : null;
    this.onPresence({
      cursor: this.pointerInside ? this.lastPointerWorld : null,
      selection: [...this.selection],
      editing: this.editing?.id ?? null,
      stroke,
      tool: this.toolInHand(),
      view: this.viewBounds(),
    });
  }

  private toolInHand(): ToolInHand | null {
    if (this.readOnly) return null;
    switch (this.tool) {
      case 'pen':
        return { kind: 'pen', color: this.pens[this.penIndex].color };
      case 'highlighter':
        return { kind: 'highlighter', color: this.highlighter.color };
      case 'eraser':
        return { kind: 'eraser', mode: this.eraser.mode };
      case 'lasso':
      case 'shape':
        return { kind: this.tool };
      default:
        return null;
    }
  }

  /** Show other people's cursors, selections and strokes in progress. */
  setRemotePeople(people: RemotePerson[]) {
    this.remote = people;
    this.hostView = people.find((p) => p.isHost && p.view)?.view ?? null;
    const now = performance.now();
    for (const p of people) {
      if (!p.trail) continue;
      let t = this.smooth.tracks.get(p.id);
      if (!t) this.smooth.tracks.set(p.id, (t = { track: new CursorTrack(), seq: -1 }));
      // Each update is added once, however many times the people list is refreshed.
      if (t.seq !== p.trail.seq) {
        t.seq = p.trail.seq;
        t.track.push(p.trail, now);
      }
    }
    this.requestRender();
  }

  /** Follow where the owner is looking, in full or just their place (or stop). `snap` jumps there instead of gliding. */
  setFollowMode(mode: FollowMode, snap = false) {
    if (mode === this.followMode) return;
    this.followMode = mode;
    this.snapFollow = snap && mode !== 'off';
    // A selection can't be kept while the view is being moved for you.
    if (mode !== 'off') this.selection.clear();
    this.emitChange();
    this.requestRender();
  }

  /** The person moved the view or picked something: follow less, or not at all. */
  private disturbFollow(did: FollowDisturbance) {
    const next = followAfterUser(this.followMode, did);
    if (next === this.followMode) return;
    this.setFollowMode(next);
    if (next === 'off') this.onFollowEnd?.();
  }

  /** Ease the camera towards the owner's view. Returns true while it is still moving. */
  private stepFollowView(): boolean {
    if (this.followMode === 'off' || !this.hostView) return false;
    const fit = followTarget(this.hostView, this.width, this.height, MIN_ZOOM, MAX_ZOOM);
    if (!fit) return false;
    // Following just the place: keep the viewer's own zoom.
    const target = this.followMode === 'position' ? { ...fit, zoom: this.cam.zoom } : fit;
    const now = performance.now();
    const dt = this.lastFollowFrame ? Math.min(100, now - this.lastFollowFrame) : 16;
    this.lastFollowFrame = now;
    const r = stepFollow(this.cam, target, this.width, this.height, 1 - Math.exp(-dt / 110), this.snapFollow);
    this.snapFollow = false;
    this.cam = r.cam;
    if (!r.moving) this.lastFollowFrame = 0;
    return r.moving;
  }

  /** Who else is editing this note or text box right now, if anyone. */
  private editedByOther(id: string): RemotePerson | undefined {
    return this.remote.find((p) => p.editing === id);
  }

  /** Move the view so a point is in the middle of the screen. */
  centerOn(p: Pt) {
    this.cam = { ...this.cam, x: p.x - this.width / 2 / this.cam.zoom, y: p.y - this.height / 2 / this.cam.zoom };
    this.viewChanged();
  }

  /** The space this editor sits in changed (a split opened or moved): measure it now, not on the next frame. */
  relayout() {
    this.resize();
  }

  private resize() {
    const r = this.host.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = r.width;
    this.height = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.render();
    this.reportPresence();
  }

  // ---------------------------------------------------------------- prefs

  private loadPrefs() {
    try {
      const p = readPrefs();
      if (TOOLS.includes(p.tool)) {
        this.tool = p.tool;
        if (isInkTool(this.tool)) this.lastInkTool = this.tool;
      }
      if (Array.isArray(p.pens) && p.pens.length === 3) {
        this.pens = this.pens.map((def, i) => {
          const x = p.pens[i] ?? {};
          return {
            color: typeof x.color === 'string' && HEX.test(x.color) ? x.color : def.color,
            size: typeof x.size === 'number' ? clamp(x.size, 1, PEN_MAX_SIZE) : def.size,
            opacity: typeof x.opacity === 'number' ? clamp(x.opacity, 0.05, 1) : 1,
            // Older prefs stored a boolean `arrow`.
            ends: x.ends === 'end' || x.ends === 'both' ? x.ends : x.arrow === true ? 'end' : 'none',
          };
        });
      }
      if (typeof p.highlighter?.color === 'string' && HEX.test(p.highlighter.color)) this.highlighter.color = p.highlighter.color;
      if (typeof p.highlighter?.size === 'number') this.highlighter.size = clamp(p.highlighter.size, 4, 80);
      if (typeof p.highlighter?.opacity === 'number') this.highlighter.opacity = clamp(p.highlighter.opacity, 0.05, 1);
      if (p.eraser?.mode === 'stroke' || p.eraser?.mode === 'area') this.eraser.mode = p.eraser.mode;
      if (typeof p.eraser?.size === 'number') this.eraser.size = clamp(Math.round(p.eraser.size), 8, 80);
      if (typeof p.customColor === 'string' && HEX.test(p.customColor)) this.customColor = p.customColor;
      if (SHAPE_TOOLS.includes(p.shapeKind)) this.shapeKind = p.shapeKind;
      if (NOTE_COLORS.includes(p.noteColor)) this.noteColor = p.noteColor;
      if (typeof p.penIndex === 'number') this.penIndex = clamp(Math.round(p.penIndex), 0, 2);
      this.inkToShape = p.inkToShape === true;
      this.dynamicInk = p.dynamicInk !== false;
      if (p.imageQuality === 'standard' || p.imageQuality === 'high') this.imageQuality = p.imageQuality;
      if (p.keys && typeof p.keys === 'object') {
        for (const a of KEY_ACTIONS) {
          const k = p.keys[a.id];
          if (typeof k === 'string' && k.length <= 20) this.keys[a.id] = k;
        }
      }
    } catch {
      /* ignore broken prefs */
    }
  }

  private savePrefs() {
    if (this.readOnly) return;
    const { tool, pens, highlighter, eraser, shapeKind, noteColor, inkToShape, penIndex, dynamicInk, imageQuality, keys, customColor } = this;
    writePrefs({ tool, pens, highlighter, eraser, shapeKind, noteColor, inkToShape, penIndex, dynamicInk, imageQuality, keys, customColor });
  }

  // ---------------------------------------------------------------- state

  get elements(): El[] {
    return this.doc.elements;
  }
  get canUndo() {
    return this.sync.canUndo;
  }
  get canRedo() {
    return this.sync.canRedo;
  }
  get isEditingText() {
    return this.editing !== null;
  }
  get isInteracting() {
    return this.state !== null;
  }

  private byId(id: string): El | undefined {
    return this.doc.elements.find((e) => e.id === id);
  }

  /** Start a new undo step. Everything changed until the next checkpoint is undone together. */
  private checkpoint() {
    this.sync.checkpoint();
  }

  /** Every change to the elements goes through here, so it's recorded for undo and sharing. */
  private setElements(next: El[]) {
    if (this.readOnly) return;
    this.doc.elements = next;
    this.sync.commit(next);
  }

  /** Allow picking things out to copy while view only (see `copyOnly`). */
  setCopyOnly(on: boolean) {
    if (on === this.copyOnly) return;
    this.copyOnly = on;
    if (!on) this.selection.clear();
    this.updateCursor();
    this.emitChange();
    this.requestRender();
  }

  /** Switch view-only mode on or off (a guest's role is only known once they've joined). */
  setReadOnly(on: boolean) {
    if (on === this.readOnly) return;
    if (on) {
      this.finishEdit();
      this.state = null;
      this.selection.clear();
    }
    this.readOnly = on;
    this.updateCursor();
    this.emitChange();
    this.requestRender();
  }

  /** The board changed from outside this editor's own edits: undo/redo, or (when shared) someone else. */
  private applyExternalChange(change: RemoteChange) {
    if (change.name !== undefined) this.doc.name = change.name;
    if (change.background) this.doc.background = change.background;
    this.glideMoved(change);
    this.doc.elements = change.elements;
    if (this.editing && !this.byId(this.editing.id)) this.finishEdit();
    this.pruneSelection();
    this.commit();
  }

  /** Elements that only moved slide from where they were to where they are now. */
  private glideMoved(change: RemoteChange) {
    if (!change.changed.size || change.changed.size > 300) return;
    const before = new Map<string, El>();
    for (const el of this.doc.elements) if (change.changed.has(el.id)) before.set(el.id, el);
    for (const el of change.elements) {
      const old = before.get(el.id);
      if (!old || old.type !== el.type) continue;
      const a = boundsOf(old), b = boundsOf(el);
      if (Math.abs(a.w - b.w) > 0.01 || Math.abs(a.h - b.h) > 0.01) continue;
      const prev = this.smooth.offsets.get(el.id);
      const dx = (prev?.dx ?? 0) + a.x - b.x, dy = (prev?.dy ?? 0) + a.y - b.y;
      // Big jumps (or none) are shown as they are.
      if (Math.hypot(dx, dy) * this.cam.zoom > 800 || (!dx && !dy)) this.smooth.offsets.delete(el.id);
      else this.smooth.offsets.set(el.id, { dx, dy });
    }
  }

  /** Move the smoothed positions on by one frame. Returns true while anything is still moving. */
  private stepSmoothing(): boolean {
    const now = performance.now();
    const dt = this.smooth.lastFrame ? Math.min(100, now - this.smooth.lastFrame) : 16;
    this.smooth.lastFrame = now;
    const ease = (tau: number) => 1 - Math.exp(-dt / tau);
    const z = this.cam.zoom;
    let moving = false;

    const present = new Set<number>();
    for (const p of this.remote) {
      present.add(p.id);
      // Cursor: glide towards where it is now.
      const shown = this.smooth.cursors.get(p.id);
      const played = p.cursor && this.smooth.tracks.get(p.id);
      if (p.cursor && played) {
        // Replay their recorded movement, a moment behind.
        const at = played.track.at(now);
        if (at) {
          if (shown) Object.assign(shown, at, { goneAt: null });
          else this.smooth.cursors.set(p.id, { ...at, goneAt: null });
        }
        if (!played.track.settled(now)) moving = true;
      } else if (p.cursor) {
        if (!shown || Math.hypot(p.cursor.x - shown.x, p.cursor.y - shown.y) * z > 1500) {
          this.smooth.cursors.set(p.id, { ...p.cursor, goneAt: null });
        } else {
          const k = ease(80);
          shown.goneAt = null;
          shown.x += (p.cursor.x - shown.x) * k;
          shown.y += (p.cursor.y - shown.y) * k;
          if (Math.hypot(p.cursor.x - shown.x, p.cursor.y - shown.y) * z > 0.3) moving = true;
          else Object.assign(shown, p.cursor);
        }
      } else if (shown) {
        // Gone (a finger lifted, or the mouse left the board): stay put for a moment, then fade,
        // so taps on a phone don't make the cursor flicker.
        shown.goneAt ??= now;
        const age = now - shown.goneAt;
        if (age >= CURSOR_LINGER_MS + CURSOR_FADE_MS) this.smooth.cursors.delete(p.id);
        else if (age >= CURSOR_LINGER_MS) moving = true;
        else this.wakeForFade(CURSOR_LINGER_MS - age);
      }
      // Live stroke: reveal the newly arrived points over the next moment.
      const pts = p.stroke?.points;
      if (pts && pts.length >= 3) {
        const total = pts.length / 3;
        const first = `${pts[0]},${pts[1]}`;
        let st = this.smooth.strokes.get(p.id);
        if (!st || st.first !== first || st.shown > total) {
          st = { first, shown: Math.min(total, 2) };
          this.smooth.strokes.set(p.id, st);
        }
        st.shown += (total - st.shown) * ease(60);
        if (total - st.shown < 0.5) st.shown = total;
        else moving = true;
      } else this.smooth.strokes.delete(p.id);
    }
    for (const id of this.smooth.cursors.keys()) if (!present.has(id)) this.smooth.cursors.delete(id);
    for (const id of this.smooth.tracks.keys()) if (!present.has(id)) this.smooth.tracks.delete(id);
    for (const id of this.smooth.strokes.keys()) if (!present.has(id)) this.smooth.strokes.delete(id);

    // Elements others moved: close the gap.
    const k = 1 - ease(60);
    for (const [id, o] of this.smooth.offsets) {
      o.dx *= k;
      o.dy *= k;
      if (Math.hypot(o.dx, o.dy) * z < 0.2) this.smooth.offsets.delete(id);
      else moving = true;
    }
    return moving;
  }

  /** Draw again when a lingering cursor should start to fade (no need to redraw every frame until then). */
  private wakeForFade(ms: number) {
    clearTimeout(this.smooth.fadeTimer);
    this.smooth.fadeTimer = window.setTimeout(() => this.requestRender(), ms + 5);
  }

  /** How visible a person's cursor is: 1 while they're here and while it lingers, fading to 0 after. */
  private cursorAlpha(id: number): number {
    const c = this.smooth.cursors.get(id);
    if (!c || c.goneAt === null) return 1;
    const fade = (performance.now() - c.goneAt - CURSOR_LINGER_MS) / CURSOR_FADE_MS;
    return fade <= 0 ? 1 : Math.max(0, 1 - fade);
  }

  /** Like drawElements, but draws elements that are still sliding at their in-between positions. */
  private drawElementsSmoothed(ctx: CanvasRenderingContext2D, opts: DrawOpts) {
    const view = this.viewBounds();
    for (const el of this.doc.elements) {
      const o = this.smooth.offsets.get(el.id);
      const b = boundsOf(el);
      if (!rectsIntersect(o ? { ...b, x: b.x + o.dx, y: b.y + o.dy } : b, view)) continue;
      if (!o) {
        drawElement(ctx, el, opts);
        continue;
      }
      ctx.save();
      ctx.translate(o.dx, o.dy);
      drawElement(ctx, el, opts);
      ctx.restore();
    }
  }

  /** Record that the document changed: save, notify the UI, redraw. */
  private commit() {
    this.doc.updatedAt = Date.now();
    this.scheduleSave();
    this.emitChange();
    this.requestRender();
  }

  // ---------------------------------------------------------------- saving

  private scheduleSave(delay = 500) {
    this.savePending = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flushSave(false), delay);
  }

  async flushSave(withThumbnail: boolean) {
    clearTimeout(this.saveTimer);
    if (!this.savePending && !withThumbnail) return;
    this.savePending = false;
    this.doc.camera = { ...this.cam };
    if (this.opts.saveYState) {
      try {
        await this.opts.saveYState(this.sync.encodeState());
      } catch (err) {
        console.error(err);
      }
    }
    if (this.opts.guest) return;
    if (this.opts.shouldSave && !this.opts.shouldSave()) return;
    let thumb: string | undefined;
    const now = Date.now();
    if (withThumbnail || now - this.lastThumb > 5000) {
      this.lastThumb = now;
      try {
        // A thumbnail is nice to have: never let it hold up saving the board.
        thumb = await Promise.race([makeThumbnail(this.doc, this.images), new Promise<undefined>((r) => setTimeout(r, 4000))]);
      } catch {
        thumb = undefined;
      }
    }
    try {
      const bytes = await saveBoard(this.doc, thumb);
      if (!this.warnedBig && bytes >= LIMITS.perBoard * LIMITS.warnAt) {
        this.warnedBig = true;
        this.onLimit({ kind: 'boardAlmostFull', bytes });
      }
    } catch (err) {
      console.error(err);
      this.onError('Could not save this board. Your browser storage may be full.');
    }
  }

  // ---------------------------------------------------------------- camera

  screenToWorld(p: Pt): Pt {
    return { x: p.x / this.cam.zoom + this.cam.x, y: p.y / this.cam.zoom + this.cam.y };
  }

  worldToScreen(p: Pt): Pt {
    return { x: (p.x - this.cam.x) * this.cam.zoom, y: (p.y - this.cam.y) * this.cam.zoom };
  }

  private toScreenRect(b: Bounds): Bounds {
    const p = this.worldToScreen(b);
    return { x: p.x, y: p.y, w: b.w * this.cam.zoom, h: b.h * this.cam.zoom };
  }

  get viewCenter(): Pt {
    return this.screenToWorld({ x: this.width / 2, y: this.height / 2 });
  }

  private viewBounds(): Bounds {
    return { x: this.cam.x, y: this.cam.y, w: this.width / this.cam.zoom, h: this.height / this.cam.zoom };
  }

  /** `user`: how the person moved the view themselves (false when the app fitted or followed something). */
  private viewChanged(user: 'pan' | 'zoom' | false = 'pan') {
    this.scheduleSave(1500);
    this.requestRender();
    this.reportPresence();
    if (user) this.disturbFollow(user);
    // The pen cursor is drawn at the ink's on-screen size, which changes with zoom.
    if (this.tool === 'pen' || this.tool === 'highlighter') this.updateCursor();
  }

  zoomAt(sp: Pt, factor: number) {
    const zoom = clamp(this.cam.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const w = this.screenToWorld(sp);
    this.cam = { x: w.x - sp.x / zoom, y: w.y - sp.y / zoom, zoom };
    this.viewChanged('zoom');
  }

  zoomBy(factor: number) {
    this.zoomAt({ x: this.width / 2, y: this.height / 2 }, factor);
  }

  setZoom(zoom: number) {
    this.zoomBy(zoom / this.cam.zoom);
  }

  zoomToBounds(b: Bounds, pad = 80, maxZoom = 2, user = true) {
    const zoom = clamp(Math.min((this.width - pad * 2) / Math.max(b.w, 1), (this.height - pad * 2) / Math.max(b.h, 1)), MIN_ZOOM, maxZoom);
    this.cam = { zoom, x: b.x + b.w / 2 - this.width / 2 / zoom, y: b.y + b.h / 2 - this.height / 2 / zoom };
    this.viewChanged(user && 'pan');
  }

  /** `user` is false when the app does this by itself (on joining a board), so it doesn't count as the person moving the view. */
  zoomToFit(user = true) {
    const b = unionBounds(this.doc.elements.map(boundsOf));
    if (!b) {
      this.cam = { x: -this.width / 2, y: -this.height / 2, zoom: 1 };
      this.viewChanged(user && 'pan');
      return;
    }
    this.zoomToBounds(b, 80, 1.5, user);
  }

  // ---------------------------------------------------------------- tools

  setTool(tool: Tool) {
    if (this.editing) this.finishEdit();
    this.tool = tool;
    if (isInkTool(tool)) this.lastInkTool = tool;
    this.savePrefs();
    if (tool !== 'select' && tool !== 'lasso') this.selection.clear();
    this.updateCursor();
    this.emitChange();
    this.requestRender();
  }

  setPen(i: number) {
    this.penIndex = i;
    this.savePrefs();
    this.setTool('pen');
  }

  updatePen(i: number, patch: Partial<PenSettings>) {
    this.pens[i] = { ...this.pens[i], ...patch };
    this.savePrefs();
    this.updateCursor();
    this.emitChange();
  }

  updateHighlighter(patch: Partial<HighlighterSettings>) {
    this.highlighter = { ...this.highlighter, ...patch };
    this.savePrefs();
    this.updateCursor();
    this.emitChange();
  }

  updateEraser(patch: Partial<EraserSettings>) {
    this.eraser = { ...this.eraser, ...patch };
    this.savePrefs();
    this.updateCursor();
    this.emitChange();
  }

  setCustomColor(color: string) {
    if (!HEX.test(color)) return;
    this.customColor = color;
    this.savePrefs();
  }

  setShapeKind(kind: ShapeTool) {
    this.shapeKind = kind;
    this.savePrefs();
    this.setTool('shape');
  }

  setInkToShape(on: boolean) {
    this.inkToShape = on;
    this.savePrefs();
    this.emitChange();
  }

  rename(name: string) {
    this.doc.name = name;
    this.sync.setMeta({ name });
    this.doc.updatedAt = Date.now();
    this.scheduleSave(0);
    this.emitChange();
  }

  setBackground(patch: Partial<Background>) {
    this.doc.background = { ...this.doc.background, ...patch };
    this.sync.setMeta({ background: this.doc.background });
    // New boards start with the background picked last.
    writePrefs({ background: this.doc.background });
    this.commit();
  }

  // ---------------------------------------------------------------- undo

  // Both update the board through applyExternalChange. The undo and redo stacks only settle
  // after that, so the UI is told again to show the right Undo/Redo buttons.
  undo() {
    if (this.editing) this.finishEdit();
    if (this.state) return;
    this.sync.undo();
    this.emitChange();
  }

  redo() {
    if (this.editing) this.finishEdit();
    if (this.state) return;
    this.sync.redo();
    this.emitChange();
  }

  private pruneSelection() {
    const ids = new Set(this.doc.elements.map((e) => e.id));
    for (const id of this.selection) if (!ids.has(id)) this.selection.delete(id);
  }

  // ---------------------------------------------------------------- selection

  selectedEls(): El[] {
    return this.doc.elements.filter((e) => this.selection.has(e.id));
  }

  selectionBounds(): Bounds | null {
    return this.selection.size ? unionBounds(this.selectedEls().map(boundsOf)) : null;
  }

  selectionScreenBounds(): Bounds | null {
    const b = this.selectionBounds();
    return b ? this.toScreenRect(b) : null;
  }

  selectAll() {
    if (this.editing) this.finishEdit();
    this.tool = 'select';
    this.selection = new Set(this.doc.elements.map((e) => e.id));
    this.updateCursor();
    this.emitChange();
    this.requestRender();
  }

  clearSelection() {
    this.selection.clear();
    this.emitChange();
    this.requestRender();
  }

  deleteSelection() {
    if (!this.selection.size) return;
    this.checkpoint();
    this.setElements(this.doc.elements.filter((e) => !this.selection.has(e.id)));
    this.selection.clear();
    this.commit();
  }

  duplicateSelection() {
    const els = this.selectedEls();
    if (!els.length) return;
    const copies = els.map((e) => ({ ...translateEl(e, 24, 24), id: uid() }));
    this.addElements(copies);
  }

  bringToFront() {
    const sel = this.selectedEls();
    if (!sel.length) return;
    this.checkpoint();
    this.setElements([...this.doc.elements.filter((e) => !this.selection.has(e.id)), ...sel]);
    this.commit();
  }

  sendToBack() {
    const sel = this.selectedEls();
    if (!sel.length) return;
    this.checkpoint();
    this.setElements([...sel, ...this.doc.elements.filter((e) => !this.selection.has(e.id))]);
    this.commit();
  }

  private mapSelection(fn: (e: El) => El) {
    if (!this.selection.size) return;
    this.checkpoint();
    this.setElements(this.doc.elements.map((e) => (this.selection.has(e.id) ? fn(e) : e)));
    this.commit();
  }

  setInkColor(color: string) {
    this.mapSelection((e) => {
      switch (e.type) {
        case 'stroke':
          return e.highlighter ? e : { ...e, color };
        case 'line':
        case 'text':
          return { ...e, color };
        case 'shape':
          return { ...e, stroke: color, fill: e.fill === 'transparent' ? 'transparent' : tint(color, 0.8) };
        default:
          return e;
      }
    });
  }

  setNoteColor(color: string) {
    this.noteColor = color;
    this.savePrefs();
    this.mapSelection((e) => (e.type === 'note' ? { ...e, color } : e));
  }

  toggleFill() {
    const shapes = this.selectedEls().filter((e): e is ShapeEl => e.type === 'shape');
    const fill = shapes.some((s) => s.fill === 'transparent');
    this.mapSelection((e) => (e.type === 'shape' ? { ...e, fill: fill ? tint(e.stroke, 0.8) : 'transparent' } : e));
  }

  nudge(dx: number, dy: number) {
    this.mapSelection((e) => translateEl(e, dx, dy));
  }

  editSelected() {
    const els = this.selectedEls();
    if (els.length === 1 && (els[0].type === 'note' || els[0].type === 'text')) this.startEdit(els[0].id, false);
  }

  // ---------------------------------------------------------------- insertion

  private addElements(els: El[], select = true) {
    if (!els.length) return;
    this.checkpoint();
    this.setElements([...this.doc.elements, ...els]);
    if (select) {
      this.tool = 'select';
      this.selection = new Set(els.map((e) => e.id));
      this.updateCursor();
    }
    this.commit();
  }

  private pointerOrCenter(): Pt {
    const p = this.lastPointerWorld;
    return p && rectContains(this.viewBounds(), p) ? p : this.viewCenter;
  }

  insertNote(color = this.noteColor, at = this.viewCenter) {
    this.noteColor = color;
    this.savePrefs();
    const note = createNote(at.x, at.y, color);
    this.addElements([note]);
    this.startEdit(note.id, true);
  }

  insertText(at = this.viewCenter, text = '') {
    const el = createText(at.x, at.y, text);
    el.y -= el.h / 2;
    if (!text) el.x -= 4;
    this.addElements([el]);
    if (!text) this.startEdit(el.id, true);
  }

  insertReaction(emoji: string, at = this.viewCenter) {
    const el = createText(at.x, at.y, emoji, { fontSize: 72 });
    el.x -= el.w / 2;
    el.y -= el.h / 2;
    this.addElements([el]);
  }

  /** Move new items to the right of the board's content if they would land on top of it. */
  private clearOfContent(els: El[]): El[] {
    const b = unionBounds(els.map(boundsOf));
    const content = unionBounds(this.doc.elements.map(boundsOf));
    if (!b || !content || !this.doc.elements.some((e) => rectsIntersect(boundsOf(e), b))) return els;
    const dx = content.x + content.w + 160 - b.x;
    const dy = content.y + content.h / 2 - (b.y + b.h / 2);
    return els.map((e) => translateEl(e, dx, dy));
  }

  insertTemplate(id: TemplateId) {
    const els = this.clearOfContent(buildTemplate(id, this.viewCenter));
    this.addElements(els);
    const b = unionBounds(els.map(boundsOf));
    if (b && !rectInside(b, this.viewBounds())) this.zoomToBounds(b, 60, 1);
  }

  async insertImageFile(file: File, at = this.viewCenter) {
    if (!file.type.startsWith('image/')) return;
    try {
      const img = await prepareImage(file, this.imageQuality);
      // The same picture added twice is stored once.
      const existing = Object.keys(this.doc.assets).find((id) => this.doc.assets[id] === img.src);
      if (!existing && !(await this.hasRoomFor(img.src.length * 0.75))) return;
      const asset = existing ?? uid();
      if (!existing && this.beforeNewAssets && !(await this.beforeNewAssets({ [asset]: img.src }))) return;
      const maxW = (this.width * 0.5) / this.cam.zoom;
      const maxH = (this.height * 0.5) / this.cam.zoom;
      const s = Math.min(1, maxW / img.width, maxH / img.height);
      const w = img.width * s, h = img.height * s;
      this.doc.assets[asset] = img.src;
      this.addElements([{ type: 'image', id: uid(), x: at.x - w / 2, y: at.y - h / 2, w, h, asset }]);
    } catch (err) {
      this.onError(err instanceof Error ? err.message : 'Could not add that image');
    }
  }

  /**
   * Put pictures of PDF pages on the board, arranged as `stack` says, and select them together.
   * `size` is each page's size in board units. Stops without adding anything if the board has no room.
   */
  async insertPages(pages: { src: string; size: { w: number; h: number } }[], stack: StackOptions): Promise<boolean> {
    if (!pages.length) return false;
    // The same page picture twice (a repeated page) is stored once.
    const ids = new Map<string, string>();
    for (const [id, src] of Object.entries(this.doc.assets)) ids.set(src, id);
    const fresh: Record<string, string> = {};
    const assetFor = pages.map((p) => {
      let id = ids.get(p.src);
      if (!id) {
        id = uid();
        ids.set(p.src, id);
        fresh[id] = p.src;
      }
      return id;
    });
    const newBytes = Object.values(fresh).reduce((sum, src) => sum + src.length * 0.75, 0);
    if (newBytes && !(await this.hasRoomFor(newBytes))) return false;
    if (Object.keys(fresh).length && this.beforeNewAssets && !(await this.beforeNewAssets(fresh))) return false;

    const { positions, w, h } = layoutPages(pages.map((p) => p.size), stack);
    const c = this.viewCenter;
    const els = this.clearOfContent(pages.map((p, i): El => ({
      type: 'image', id: uid(), x: c.x - w / 2 + positions[i].x, y: c.y - h / 2 + positions[i].y, w: p.size.w, h: p.size.h, asset: assetFor[i],
    })));
    Object.assign(this.doc.assets, fresh);
    this.addElements(els);
    // Show the whole selected group, so its outline and handles are there to adjust. A long document would
    // shrink to nothing that way, so it shows just its first page instead; the rest is a pan or zoom away.
    const all = unionBounds(els.map(boundsOf));
    if (all && !rectInside(all, this.viewBounds())) {
      const fit = Math.min((this.width - 160) / all.w, (this.height - 160) / all.h);
      this.zoomToBounds(fit >= 0.2 ? all : boundsOf(els[0]), 80, 1);
    }
    return true;
  }

  /** Images that arrived from a shared board's room. */
  addAssets(assets: Record<string, string>) {
    Object.assign(this.doc.assets, assets);
    this.scheduleSave();
    this.requestRender();
  }

  /** Check the board and overall storage limits before adding this many bytes. */
  private async hasRoomFor(extraBytes: number): Promise<boolean> {
    // A guest stores nothing here; desktop app has no artificial storage limits.
    if (this.opts.guest || isElectron) return true;
    if (estimateDocBytes(this.doc) + extraBytes > LIMITS.perBoard) {
      this.onLimit({ kind: 'boardFull' });
      return false;
    }
    const usage = await getUsage();
    if (usage.bytes + extraBytes > usage.budget) {
      this.onLimit({ kind: 'storageFull', usage });
      return false;
    }
    return true;
  }

  async exportPNG(): Promise<Blob | null> {
    if (!this.doc.elements.length) return null;
    await this.images.ensure(this.doc.elements, this.doc.assets);
    const canvas = renderBoard(this.doc, this.images, { padding: 48, scale: 2 });
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  }

  // ---------------------------------------------------------------- text editing

  /** Open an inline editor on a note or text box. `fresh` means it was just created. */
  startEdit(id: string, fresh: boolean) {
    if (this.editing) this.finishEdit();
    const el = this.byId(id);
    if (!el || (el.type !== 'note' && el.type !== 'text')) return;
    const other = this.editedByOther(id);
    if (other) {
      this.onError(`${other.name} is editing this right now`);
      return;
    }
    if (!fresh) this.checkpoint();
    this.tool = 'select';
    this.selection = new Set([id]);

    const ta = document.createElement('textarea');
    ta.className = 'wb-text-editor';
    ta.value = el.text;
    ta.spellcheck = true;
    ta.setAttribute('aria-label', el.type === 'note' ? 'Note text' : 'Text');
    ta.style.fontFamily = FONT_FAMILY;
    ta.style.lineHeight = String(LINE_HEIGHT);
    this.host.append(ta);
    ta.addEventListener('input', () => this.updateEditingText(ta.value));
    ta.addEventListener('blur', () => this.finishEdit());
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        ta.blur();
      }
    });
    this.editing = { id, ta };
    this.positionEditor();
    // Focus now so no keystrokes are lost, and again next frame in case the click that opened us moves focus.
    const focus = () => {
      if (this.editing?.ta !== ta || document.activeElement === ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    };
    focus();
    requestAnimationFrame(focus);
    this.updateCursor();
    this.emitChange();
    this.requestRender();
  }

  private updateEditingText(text: string) {
    const ed = this.editing;
    if (!ed) return;
    this.setElements(this.doc.elements.map((e) => {
      if (e.id !== ed.id) return e;
      if (e.type === 'text') {
        const box = fitTextBox(text, e.fontSize, e.w, e.autoWidth);
        return { ...e, text, w: box.w, h: box.h };
      }
      return e.type === 'note' ? { ...e, text } : e;
    }));
    this.requestRender();
  }

  finishEdit() {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    ed.ta.remove();
    const el = this.byId(ed.id);
    if (el?.type === 'text' && !el.text.trim()) {
      this.setElements(this.doc.elements.filter((e) => e !== el));
      this.selection.delete(el.id);
    }
    this.commit();
  }

  private positionEditor() {
    const ed = this.editing;
    if (!ed) return;
    const el = this.byId(ed.id);
    if (!el || (el.type !== 'note' && el.type !== 'text')) return;
    const z = this.cam.zoom;
    const s = this.worldToScreen(el);
    const st = ed.ta.style;
    // The box keeps its place and turns about the element's center, wherever that is within it.
    const rot = rotationOf(el);
    const cx = s.x + (el.w * z) / 2, cy = s.y + (el.h * z) / 2;
    if (el.type === 'note') {
      const fit = fitNote(el.text || ' ', el.w, el.h);
      const th = Math.max(1, fit.lines.length) * fit.size * LINE_HEIGHT;
      st.left = `${s.x + NOTE_PAD * z}px`;
      st.top = `${s.y + Math.max(NOTE_PAD, (el.h - th) / 2) * z}px`;
      st.width = `${(el.w - NOTE_PAD * 2) * z}px`;
      st.height = `${Math.min(th, el.h - NOTE_PAD * 2) * z}px`;
      st.fontSize = `${fit.size * z}px`;
      st.color = NOTE_TEXT_COLOR;
      st.textAlign = 'center';
      st.whiteSpace = 'pre-wrap';
    } else {
      st.left = `${s.x}px`;
      st.top = `${s.y}px`;
      st.width = `${el.w * z + el.fontSize * z}px`;
      st.height = `${el.h * z}px`;
      st.fontSize = `${el.fontSize * z}px`;
      st.color = el.color;
      st.textAlign = 'left';
      st.whiteSpace = el.autoWidth ? 'pre' : 'pre-wrap';
    }
    st.transform = rot ? `rotate(${rot}rad)` : '';
    st.transformOrigin = rot ? `${cx - parseFloat(st.left)}px ${cy - parseFloat(st.top)}px` : '';
  }

  // ---------------------------------------------------------------- pointer input

  private screenPoint(e: { clientX: number; clientY: number }): Pt {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private pressure(e: PointerEvent): number {
    return this.dynamicInk && e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5;
  }

  private hitAt(wp: Pt): El | null {
    const tol = 6 / this.cam.zoom;
    const els = this.doc.elements;
    for (let i = els.length - 1; i >= 0; i--) if (hitTest(els[i], wp, tol)) return els[i];
    return null;
  }

  /** The turned frame, if the selection still fits it. */
  private activeFrame(): SelFrame | null {
    const f = this.turned;
    if (!f) return null;
    const sel = this.selectedEls();
    if (sel.length !== f.els.length || sel.some((e, i) => e !== f.els[i])) {
      this.turned = null;
      return null;
    }
    return f;
  }

  /** The frame a selection starts turning from: snug around a lone box-shaped element, else the plain box. */
  private freshFrame(els: El[]): SelFrame | null {
    const el = els.length === 1 ? els[0] : null;
    if (el && el.type !== 'stroke' && el.type !== 'line') {
      const b = boundsOf({ ...el, rotation: undefined });
      return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h, angle: el.rotation ?? 0, els };
    }
    const b = unionBounds(els.map(boundsOf));
    return b ? { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h, angle: 0, els } : null;
  }

  /** The selection box as drawn on screen: its center, size and how far it's turned. */
  private screenFrame(): { c: Pt; w: number; h: number; angle: number } | null {
    const f = this.activeFrame();
    if (f) {
      const z = this.cam.zoom;
      return { c: this.worldToScreen({ x: f.cx, y: f.cy }), w: f.w * z, h: f.h * z, angle: f.angle };
    }
    const b = this.selectionScreenBounds();
    return b ? { c: { x: b.x + b.w / 2, y: b.y + b.h / 2 }, w: b.w, h: b.h, angle: 0 } : null;
  }

  /** Whether a board point is inside the selection box, however it's turned. */
  private inSelectionBox(wp: Pt): boolean {
    const f = this.activeFrame();
    if (!f) {
      const b = this.selectionBounds();
      return !!b && rectContains(b, wp);
    }
    const q = rotatePt(wp, { x: f.cx, y: f.cy }, -f.angle);
    return Math.abs(q.x - f.cx) <= f.w / 2 && Math.abs(q.y - f.cy) <= f.h / 2;
  }

  /** Handle positions of an upright box around `c`. */
  private handlePoints(c: Pt, w: number, h: number): Record<Handle, Pt> {
    const x = c.x - w / 2, y = c.y - h / 2;
    return {
      nw: { x, y }, n: { x: x + w / 2, y }, ne: { x: x + w, y }, e: { x: x + w, y: y + h / 2 },
      se: { x: x + w, y: y + h }, s: { x: x + w / 2, y: y + h }, sw: { x, y: y + h }, w: { x, y: y + h / 2 },
    };
  }

  private handleAt(sp: Pt): Handle | null {
    if ((this.tool !== 'select' && this.tool !== 'lasso') || !this.selection.size || this.editing) return null;
    const fr = this.screenFrame();
    if (!fr) return null;
    // Look at the pointer from the box's own point of view, where the box is upright.
    const q = rotatePt(sp, fr.c, -fr.angle);
    const pts = this.handlePoints(fr.c, fr.w, fr.h);
    for (const hd of HANDLES) {
      if (Math.abs(q.x - pts[hd].x) <= HANDLE_SIZE && Math.abs(q.y - pts[hd].y) <= HANDLE_SIZE) return hd;
    }
    return null;
  }

  /** The corner whose outside this point is near, when it's close enough to grab for turning. */
  private rotateCornerAt(sp: Pt): Corner | null {
    if ((this.tool !== 'select' && this.tool !== 'lasso') || !this.selection.size || this.editing) return null;
    const fr = this.screenFrame();
    if (!fr) return null;
    const q = rotatePt(sp, fr.c, -fr.angle);
    const pts = this.handlePoints(fr.c, fr.w, fr.h);
    const corners: [Corner, number, number][] = [['nw', -1, -1], ['ne', 1, -1], ['se', 1, 1], ['sw', -1, 1]];
    for (const [corner, sx, sy] of corners) {
      const dx = (q.x - pts[corner].x) * sx, dy = (q.y - pts[corner].y) * sy;
      if (dx >= 0 && dy >= 0 && Math.hypot(dx, dy) <= ROTATE_ZONE) return corner;
    }
    return null;
  }

  private onPointerDown(e: PointerEvent) {
    if (this.editing) this.finishEdit();
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();

    const sp = this.screenPoint(e);
    this.pointers.set(e.pointerId, sp);
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    if (this.pointers.size === 2) {
      this.beginPinch();
      return;
    }
    if (this.pointers.size > 2 || this.state) return;

    const wp = this.screenToWorld(sp);
    this.lastPointerWorld = wp;
    // Picking things out to copy, on a board that can't be changed.
    const lookSelect = this.readOnly && this.copyOnly && this.tool === 'select';
    if (e.button === 1 || (e.button === 0 && (this.spaceDown || this.tool === 'hand' || (this.readOnly && !lookSelect)))) {
      e.preventDefault();
      this.state = { kind: 'pan', sx: sp.x, sy: sp.y, cam: { ...this.cam } };
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    if (lookSelect) {
      if (e.button === 0) this.beginLookSelect(e, wp);
      this.emitChange();
      this.requestRender();
      return;
    }
    // The eraser end of a stylus reports button 5.
    const penEraser = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0);
    if (e.button !== 0 && !penEraser) return;

    const tool: Tool = penEraser ? 'eraser' : this.tool;
    switch (tool) {
      case 'pen':
      case 'highlighter': {
        const hl = tool === 'highlighter';
        const pen = this.pens[this.penIndex];
        const raw = [wp.x, wp.y, this.pressure(e)];
        this.state = {
          kind: 'draw',
          raw,
          last: wp,
          // Mouse and touch have no pressure, so thickness follows drawing speed instead.
          dynamic: this.dynamicInk && e.pointerType !== 'pen',
          straight: false,
          snap: false,
          el: {
            type: 'stroke',
            id: uid(),
            points: raw,
            color: hl ? this.highlighter.color : pen.color,
            size: hl ? this.highlighter.size : pen.size,
            highlighter: hl || undefined,
            arrow: (!hl && pen.ends !== 'none') || undefined,
            arrowStart: (!hl && pen.ends === 'both') || undefined,
            // Only stored when it differs from the default, to keep files small.
            opacity: hl ? (this.highlighter.opacity !== 0.4 ? this.highlighter.opacity : undefined) : pen.opacity < 1 ? pen.opacity : undefined,
          },
        };
        this.updateStrokeShape(e.shiftKey);
        break;
      }
      case 'eraser':
        this.state = { kind: 'erase', erased: false, last: wp, sp, t: e.timeStamp, speed: 0, size: this.eraser.size };
        this.eraseSegment(wp, wp);
        // The eraser is drawn on the canvas while pressed, since it changes size as it moves.
        this.cursorKey = this.canvas.style.cursor = 'none';
        break;
      case 'select':
      case 'lasso':
        this.beginSelectGesture(e, sp, wp, tool);
        break;
      case 'shape':
        this.state = { kind: 'create', id: uid(), start: wp, el: null };
        break;
    }
    this.emitChange();
    this.requestRender();
  }

  /** Select by clicking or dragging a box. Nothing can be moved, so there are no handles and no dragging items. */
  private beginLookSelect(e: PointerEvent, wp: Pt) {
    const hit = this.hitAt(wp);
    if (hit) {
      if (e.shiftKey && this.selection.has(hit.id)) this.selection.delete(hit.id);
      else if (e.shiftKey) this.selection.add(hit.id);
      else this.selection = new Set([hit.id]);
      return;
    }
    const base = e.shiftKey ? new Set(this.selection) : new Set<string>();
    this.selection = new Set(base);
    this.state = { kind: 'marquee', start: wp, cur: wp, base };
  }

  private beginSelectGesture(e: PointerEvent, sp: Pt, wp: Pt, tool: 'select' | 'lasso') {
    const handle = this.handleAt(sp);
    if (handle) {
      if (e.altKey) e.preventDefault();
      const originals = this.selectedEls();
      const frame = this.activeFrame();
      const c = frame ? { x: frame.cx, y: frame.cy } : null;
      const locals = frame && c ? originals.map((o) => rotateEl(o, c, -frame.angle)) : originals;
      const from = unionBounds(locals.map(boundsOf));
      if (from) {
        this.state = { kind: 'resize', handle, from, originals, locals, frame, changed: false };
        return;
      }
    }
    const corner = this.rotateCornerAt(sp);
    if (corner) {
      const originals = this.selectedEls();
      const frame = this.activeFrame() ?? this.freshFrame(originals);
      if (frame) {
        this.state = {
          kind: 'rotate', corner, frame, start: Math.atan2(wp.y - frame.cy, wp.x - frame.cx), angle: 0, originals, changed: false,
        };
        this.canvas.style.cursor = rotateCursor(corner, frame.angle);
        return;
      }
    }
    const hit = tool === 'select' ? this.hitAt(wp) : null;
    const move = (clickId: string | null) => {
      this.state = { kind: 'move', start: wp, sx: sp.x, sy: sp.y, originals: this.selectedEls(), moved: false, clickId, frame: this.activeFrame() };
    };
    if (hit) {
      if (e.shiftKey) {
        if (this.selection.has(hit.id)) this.selection.delete(hit.id);
        else this.selection.add(hit.id);
        if (this.selection.has(hit.id)) move(null);
        return;
      }
      if (this.selection.has(hit.id)) move(hit.id);
      else {
        this.selection = new Set([hit.id]);
        move(null);
      }
    } else if (this.inSelectionBox(wp) && !e.shiftKey) {
      move(null);
    } else {
      const base = e.shiftKey ? new Set(this.selection) : new Set<string>();
      this.selection = new Set(base);
      this.state = tool === 'lasso' ? { kind: 'lasso', pts: [wp], base } : { kind: 'marquee', start: wp, cur: wp, base };
    }
  }

  private onPointerMove(e: PointerEvent) {
    const sp = this.screenPoint(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, sp);
    const wp = this.screenToWorld(sp);
    this.lastPointerWorld = wp;
    this.pointerInside = true;
    const st = this.state;
    this.reportPresence();
    // The release was missed (e.g. alt-tabbed away while pressing), so end the gesture.
    if (st && st.kind !== 'pinch' && e.pointerType !== 'touch' && e.buttons === 0) {
      this.onPointerUp(e);
      return;
    }
    if (!st) {
      this.updateHoverCursor(sp, wp);
      return;
    }

    switch (st.kind) {
      case 'pan':
        this.cam = { ...this.cam, x: st.cam.x - (sp.x - st.sx) / this.cam.zoom, y: st.cam.y - (sp.y - st.sy) / this.cam.zoom };
        this.viewChanged();
        break;
      case 'pinch':
        this.updatePinch(st);
        break;
      case 'draw': {
        const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
        const pts = st.raw;
        for (const ev of events.length ? events : [e]) {
          const p = this.screenToWorld(this.screenPoint(ev));
          if (Math.hypot(p.x - st.last.x, p.y - st.last.y) * this.cam.zoom < 0.75) continue;
          const n = pts.length;
          const f = filterPoint({ x: pts[n - 3], y: pts[n - 2] }, p, this.cam.zoom);
          st.last = p;
          pts.push(f.x, f.y, this.pressure(ev));
        }
        this.updateStrokeShape(e.shiftKey);
        break;
      }
      case 'erase': {
        // Smooth the speed over time so the size swells and settles instead of jumping.
        const dt = Math.max(1, e.timeStamp - st.t);
        const speed = Math.hypot(sp.x - st.sp.x, sp.y - st.sp.y) / dt;
        st.speed += (speed - st.speed) * (1 - Math.exp(-dt / 80));
        const fast = clamp((st.speed - ERASER_SLOW_SPEED) / (ERASER_FAST_SPEED - ERASER_SLOW_SPEED), 0, 1);
        st.size = this.eraser.size * (1 + fast * (ERASER_MAX_GROWTH - 1));
        st.sp = sp;
        st.t = e.timeStamp;
        this.eraseSegment(st.last, wp);
        st.last = wp;
        this.requestRender();
        break;
      }
      case 'lasso': {
        const last = st.pts[st.pts.length - 1];
        if (Math.hypot(wp.x - last.x, wp.y - last.y) * this.cam.zoom > 3) st.pts.push(wp);
        this.requestRender();
        break;
      }
      case 'marquee': {
        st.cur = wp;
        const r = normRect(st.start.x, st.start.y, wp.x - st.start.x, wp.y - st.start.y);
        const sel = new Set(st.base);
        for (const el of this.doc.elements) if (rectInside(boundsOf(el), r)) sel.add(el.id);
        this.selection = sel;
        this.requestRender();
        break;
      }
      case 'move': {
        if (!st.moved) {
          if (Math.hypot(sp.x - st.sx, sp.y - st.sy) < 3) return;
          st.moved = true;
          this.checkpoint();
          this.emitChange();
        }
        const dx = wp.x - st.start.x, dy = wp.y - st.start.y;
        const moved = new Map(st.originals.map((o) => [o.id, translateEl(o, dx, dy)] as const));
        this.setElements(this.doc.elements.map((el) => moved.get(el.id) ?? el));
        if (st.frame) this.turned = { ...st.frame, cx: st.frame.cx + dx, cy: st.frame.cy + dy, els: this.selectedEls() };
        this.requestRender();
        break;
      }
      case 'resize': {
        this.applyResize(st, wp, e.shiftKey, e.altKey);
        break;
      }
      case 'rotate': {
        if (!st.changed) {
          st.changed = true;
          this.checkpoint();
        }
        const f = st.frame;
        let angle = Math.atan2(wp.y - f.cy, wp.x - f.cx) - st.start;
        // Snap the box's own angle to 15° steps.
        if (e.shiftKey) angle = Math.round((f.angle + angle) / (Math.PI / 12)) * (Math.PI / 12) - f.angle;
        st.angle = angle;
        const turned = new Map(st.originals.map((o) => [o.id, rotateEl(o, { x: f.cx, y: f.cy }, angle)] as const));
        this.setElements(this.doc.elements.map((el) => turned.get(el.id) ?? el));
        this.turned = { ...f, angle: f.angle + angle, els: this.selectedEls() };
        this.canvas.style.cursor = rotateCursor(st.corner, f.angle + angle);
        this.requestRender();
        break;
      }
      case 'create':
        st.el = this.buildShape(st.id, st.start, wp, e.shiftKey, e.altKey);
        this.requestRender();
        break;
    }
  }

  private onPointerUp(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    const st = this.state;
    if (!st) return;
    if (st.kind === 'pinch') {
      if (this.pointers.size < 2) {
        this.state = null;
        this.updateCursor();
        this.emitChange();
      }
      return;
    }
    this.state = null;

    switch (st.kind) {
      case 'draw':
        this.finishStroke(st.el);
        break;
      case 'erase':
        if (st.erased) this.commit();
        break;
      case 'lasso':
        if (st.pts.length > 2) {
          const sel = new Set(st.base);
          for (const el of this.doc.elements) if (inLasso(el, st.pts)) sel.add(el.id);
          this.selection = sel;
        }
        break;
      case 'move':
        if (st.moved) this.commit();
        else if (st.clickId && !e.shiftKey) this.selection = new Set([st.clickId]);
        break;
      case 'resize':
      case 'rotate':
        if (st.changed) this.commit();
        break;
      case 'create': {
        let el = st.el;
        const b = el ? boundsOf(el) : null;
        if (!el || !b || Math.max(b.w, b.h) * this.cam.zoom < 6) el = this.defaultShape(st.id, st.start);
        this.addElements([el]);
        break;
      }
      default:
        break;
    }
    this.updateCursor();
    this.emitChange();
    this.requestRender();
  }

  private finishStroke(el: StrokeEl) {
    if (this.inkToShape && !el.highlighter && !el.arrow && !el.arrowStart) {
      const r = recognizeShape(el.points);
      if (r) {
        const strokeWidth = Math.max(1.5, el.size);
        const shaped: El =
          r.type === 'line'
            ? { type: 'line', id: el.id, x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2, color: el.color, strokeWidth, arrowEnd: false }
            : { type: 'shape', id: el.id, kind: r.kind, x: r.x, y: r.y, w: r.w, h: r.h, stroke: el.color, fill: 'transparent', strokeWidth };
        this.addElements([shaped], false);
        return;
      }
    }
    this.addElements([el], false);
  }

  /**
   * While drawing, pressing Shift turns the stroke into a straight line from where it started to the pointer.
   * The line stays straight after Shift is released, but only snaps to horizontal/vertical/45° while it's held.
   */
  private updateStrokeShape(shift: boolean) {
    const st = this.state;
    if (!st || st.kind !== 'draw') return;
    if (shift) st.straight = true;
    st.snap = shift;
    const straight = st.straight;
    const raw = st.raw;
    let points = raw;
    if (straight && raw.length >= 6) {
      const x0 = raw[0], y0 = raw[1];
      let x1 = raw[raw.length - 3], y1 = raw[raw.length - 2];
      const len = Math.hypot(x1 - x0, y1 - y0);
      // Snap to horizontal, vertical and 45° when close.
      const angle = Math.atan2(y1 - y0, x1 - x0);
      const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
      if (st.snap && Math.abs(angle - snapped) < (5 * Math.PI) / 180) {
        x1 = x0 + Math.cos(snapped) * len;
        y1 = y0 + Math.sin(snapped) * len;
      }
      // Evenly spaced points at constant pressure give an even, clean line.
      const steps = Math.max(1, Math.ceil(len / 4));
      points = [];
      for (let i = 0; i <= steps; i++) points.push(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, 0.5);
    }
    // New object so the cached outline is rebuilt.
    st.el = { ...st.el, points, simulatePressure: (!straight && st.dynamic) || undefined };
    this.requestRender();
  }

  private beginPinch() {
    const st = this.state;
    if (st) {
      const changed = (st.kind === 'move' && st.moved) || ((st.kind === 'resize' || st.kind === 'rotate') && st.changed) || (st.kind === 'erase' && st.erased);
      if (changed) this.commit();
      // An in-progress stroke is discarded: the second finger means "navigate".
    }
    const [a, b] = [...this.pointers.values()];
    this.state = {
      kind: 'pinch',
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      cam: { ...this.cam },
    };
    this.emitChange();
    this.requestRender();
  }

  private updatePinch(st: Extract<Interaction, { kind: 'pinch' }>) {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const zoom = clamp((st.cam.zoom * dist) / st.dist, MIN_ZOOM, MAX_ZOOM);
    const wx = st.cam.x + st.mid.x / st.cam.zoom;
    const wy = st.cam.y + st.mid.y / st.cam.zoom;
    // Two fingers that mostly slide are moving the view; ones that spread or pinch are zooming it.
    this.cam = { x: wx - mid.x / zoom, y: wy - mid.y / zoom, zoom };
    this.viewChanged(Math.abs(zoom / st.cam.zoom - 1) > 0.02 ? 'zoom' : 'pan');
  }

  private eraseSegment(a: Pt, b: Pt) {
    const st = this.state;
    if (!st || st.kind !== 'erase') return;
    const area = this.eraser.mode === 'area';
    const r = st.size / 2 / this.cam.zoom;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (r * 0.5)));
    const samples: Pt[] = [];
    for (let i = 0; i <= steps; i++) samples.push({ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps });
    const swept: Bounds = {
      x: Math.min(a.x, b.x) - r,
      y: Math.min(a.y, b.y) - r,
      w: Math.abs(b.x - a.x) + r * 2,
      h: Math.abs(b.y - a.y) + r * 2,
    };

    let changed = false;
    const next: El[] = [];
    for (const el of this.doc.elements) {
      if ((el.type !== 'stroke' && el.type !== 'line' && el.type !== 'shape') || !rectsIntersect(boundsOf(el), swept)) {
        next.push(el);
        continue;
      }
      // Shapes are always erased whole; the square eraser cuts ink and lines where it passes.
      if (!area || el.type === 'shape') {
        if (samples.some((p) => eraseHit(el, p, r))) changed = true;
        else next.push(el);
        continue;
      }
      let pieces: (StrokeEl | LineEl)[] = [el];
      for (const p of samples) {
        const sq: Bounds = { x: p.x - r, y: p.y - r, w: r * 2, h: r * 2 };
        pieces = pieces.flatMap((piece) => (rectsIntersect(boundsOf(piece), sq) && this.cutElement(piece, sq)) || [piece]);
      }
      if (pieces.length === 1 && pieces[0] === el) next.push(el);
      else {
        changed = true;
        next.push(...pieces);
      }
    }
    if (!changed) return;
    if (!st.erased) {
      st.erased = true;
      this.checkpoint();
    }
    const kept = new Set(next.map((el) => el.id));
    this.setElements(next);
    for (const id of [...this.selection]) if (!kept.has(id)) this.selection.delete(id);
  }

  /** What's left of an ink stroke or line after rubbing out square `sq`, or null when it's untouched. */
  private cutElement(el: StrokeEl | LineEl, sq: Bounds): (StrokeEl | LineEl)[] | null {
    if (el.type === 'stroke') {
      // Grow the square by the ink's half-width so the cut ends' round caps stop at its edge.
      const pts = el.points;
      const pieces = cutPolyline(pts, { x: sq.x - el.size / 2, y: sq.y - el.size / 2, w: sq.w + el.size, h: sq.h + el.size });
      if (!pieces) return null;
      const n = pts.length;
      return pieces.map((p, i) => ({
        ...el,
        id: i ? uid() : el.id,
        points: p,
        // Arrowheads survive only on the piece that still has that end.
        arrowStart: (el.arrowStart && p[0] === pts[0] && p[1] === pts[1]) || undefined,
        arrow: (el.arrow && p[p.length - 3] === pts[n - 3] && p[p.length - 2] === pts[n - 2]) || undefined,
      }));
    }
    const pad = el.strokeWidth / 2;
    const c = clipSegment(el.x1, el.y1, el.x2, el.y2, { x: sq.x - pad, y: sq.y - pad, w: sq.w + pad * 2, h: sq.h + pad * 2 });
    if (!c) return null;
    const dx = el.x2 - el.x1, dy = el.y2 - el.y1;
    const out: LineEl[] = [];
    if (c[0] > 0) out.push({ ...el, x2: el.x1 + dx * c[0], y2: el.y1 + dy * c[0], arrowEnd: false });
    if (c[1] < 1) out.push({ ...el, id: out.length ? uid() : el.id, x1: el.x1 + dx * c[1], y1: el.y1 + dy * c[1] });
    return out;
  }

  private applyResize(st: Extract<Interaction, { kind: 'resize' }>, wp: Pt, shiftKey: boolean, altKey: boolean) {
    if (!st.changed) {
      st.changed = true;
      this.checkpoint();
    }
    const f = st.frame;
    if (f) {
      // Resize in the box's own upright space, then turn the result back.
      const c = { x: f.cx, y: f.cy };
      const to = this.resizeTarget(st, rotatePt(wp, c, -f.angle), shiftKey, altKey);
      const resized = new Map(st.locals.map((o) => [o.id, rotateEl(transformEl(o, st.from, to), c, f.angle)] as const));
      this.setElements(this.doc.elements.map((el) => resized.get(el.id) ?? el));
      const mid = rotatePt({ x: to.x + to.w / 2, y: to.y + to.h / 2 }, c, f.angle);
      this.turned = { cx: mid.x, cy: mid.y, w: to.w, h: to.h, angle: f.angle, els: this.selectedEls() };
    } else {
      const to = this.resizeTarget(st, wp, shiftKey, altKey);
      const resized = new Map(st.originals.map((o) => [o.id, transformEl(o, st.from, to)] as const));
      this.setElements(this.doc.elements.map((el) => resized.get(el.id) ?? el));
    }
    this.requestRender();
  }

  private resizeTarget(st: Extract<Interaction, { kind: 'resize' }>, wp: Pt, shift: boolean, alt: boolean = false): Bounds {
    const keepRatio = st.originals.some((o) => o.type !== 'shape' && o.type !== 'line');
    return resizeBounds(st.from, st.handle, wp, 4 / this.cam.zoom, keepRatio, shift, alt);
  }

  private shapeStyle() {
    return { color: this.pens[this.penIndex].color, strokeWidth: 3 };
  }

  private buildShape(id: string, start: Pt, wp: Pt, shift: boolean, alt: boolean = false): ShapeEl | LineEl {
    const { color, strokeWidth } = this.shapeStyle();
    const kind = this.shapeKind;
    if (kind === 'line' || kind === 'arrow') {
      let x2 = wp.x, y2 = wp.y;
      if (shift) {
        const len = Math.hypot(x2 - start.x, y2 - start.y);
        const a = Math.round(Math.atan2(y2 - start.y, x2 - start.x) / (Math.PI / 12)) * (Math.PI / 12);
        x2 = start.x + Math.cos(a) * len;
        y2 = start.y + Math.sin(a) * len;
      }
      return { type: 'line', id, x1: start.x, y1: start.y, x2, y2, color, strokeWidth, arrowEnd: kind === 'arrow' };
    }
    let w = wp.x - start.x, h = wp.y - start.y;
    if (shift) {
      const m = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * m;
      h = Math.sign(h || 1) * m;
    }
    const originX = alt ? start.x - w : start.x;
    const originY = alt ? start.y - h : start.y;
    const totalW = alt ? w * 2 : w;
    const totalH = alt ? h * 2 : h;
    return { type: 'shape', id, kind, ...normRect(originX, originY, totalW, totalH), stroke: color, fill: 'transparent', strokeWidth };
  }

  private updateCreateShape(shiftKey: boolean, altKey: boolean) {
    if (this.state?.kind !== 'create' || !this.lastPointerWorld) return;
    this.state.el = this.buildShape(this.state.id, this.state.start, this.lastPointerWorld, shiftKey, altKey);
    this.requestRender();
  }

  private defaultShape(id: string, c: Pt): ShapeEl | LineEl {
    const { color, strokeWidth } = this.shapeStyle();
    const kind = this.shapeKind;
    if (kind === 'line' || kind === 'arrow') {
      return { type: 'line', id, x1: c.x - 100, y1: c.y, x2: c.x + 100, y2: c.y, color, strokeWidth, arrowEnd: kind === 'arrow' };
    }
    const size = { rect: [200, 140], ellipse: [180, 180], triangle: [180, 160], diamond: [180, 180] }[kind];
    return { type: 'shape', id, kind, x: c.x - size[0] / 2, y: c.y - size[1] / 2, w: size[0], h: size[1], stroke: color, fill: 'transparent', strokeWidth };
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const sp = this.screenPoint(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1;
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch arrives as ctrl+wheel with small deltas.
      this.zoomAt(sp, Math.exp(-e.deltaY * unit * 0.0025));
      return;
    }
    let dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (e.shiftKey && !dx) {
      dx = dy;
      dy = 0;
    }
    this.cam = { ...this.cam, x: this.cam.x + dx / this.cam.zoom, y: this.cam.y + dy / this.cam.zoom };
    this.viewChanged();
  }

  private onDblClick(e: MouseEvent) {
    if (this.tool !== 'select' || this.readOnly) return;
    const wp = this.screenToWorld(this.screenPoint(e));
    const hit = this.hitAt(wp);
    if (hit && (hit.type === 'note' || hit.type === 'text')) this.startEdit(hit.id, false);
    else if (!hit) this.insertText(wp);
  }

  // ---------------------------------------------------------------- keyboard & clipboard

  private onKeyDown(e: KeyboardEvent) {
    if (isTypingTarget(e.target) || document.querySelector('.modal-backdrop')) return;
    if (this.opts.acceptKey && !this.opts.acceptKey(e)) return;
    if (e.key === 'Shift') {
      this.updateStrokeShape(true);
      if (this.state?.kind === 'resize' && this.lastPointerWorld) {
        this.applyResize(this.state, this.lastPointerWorld, true, e.altKey);
      }
      this.updateCreateShape(true, e.altKey);
      return;
    }
    if (e.key === 'Alt') {
      if (this.state?.kind === 'resize') {
        e.preventDefault();
        if (this.lastPointerWorld) {
          this.applyResize(this.state, this.lastPointerWorld, e.shiftKey, true);
        }
      } else if (this.state?.kind === 'create') {
        e.preventDefault();
        this.updateCreateShape(e.shiftKey, true);
      }
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    if (this.readOnly) {
      // Moving around, and (where copying is allowed) picking what to copy.
      const nav = mod
        ? ['=', '+', '-', '0', ...(this.copyOnly ? ['a'] : [])].includes(key.toLowerCase())
        : key === ' ' || (e.shiftKey && e.code === 'Digit1') || (this.copyOnly && key === 'Escape');
      if (!nav) return;
    }

    if (key === ' ') {
      e.preventDefault();
      if (!this.spaceDown) {
        this.spaceDown = true;
        this.updateCursor();
      }
      return;
    }
    if (mod) {
      const handled: Record<string, () => void> = {
        z: () => (e.shiftKey ? this.redo() : this.undo()),
        y: () => this.redo(),
        a: () => this.selectAll(),
        d: () => this.duplicateSelection(),
        '=': () => this.zoomBy(1.25),
        '+': () => this.zoomBy(1.25),
        '-': () => this.zoomBy(1 / 1.25),
        '0': () => this.setZoom(1),
      };
      const fn = handled[key.toLowerCase()];
      if (fn) {
        e.preventDefault();
        fn();
      }
      return;
    }
    if (e.altKey) return;
    if (e.shiftKey && e.code === 'Digit1') {
      e.preventDefault();
      this.zoomToFit();
      return;
    }

    const arrows: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (arrows[key] && this.selection.size) {
      e.preventDefault();
      const d = (e.shiftKey ? 10 : 1) / this.cam.zoom;
      this.nudge(arrows[key][0] * d, arrows[key][1] * d);
      return;
    }
    switch (key) {
      case 'Delete':
      case 'Backspace':
        if (this.selection.size) {
          e.preventDefault();
          this.deleteSelection();
        }
        return;
      case 'Escape':
        this.clearSelection();
        return;
      case 'Enter':
        if (this.selection.size === 1) {
          e.preventDefault();
          this.editSelected();
        }
        return;
    }

    const actions: Record<KeyAction, () => void> = {
      select: () => this.setTool('select'),
      hand: () => this.setTool('hand'),
      pen: () => this.setPen(this.tool === 'pen' ? (this.penIndex + 1) % 3 : this.penIndex),
      pen1: () => this.setPen(0),
      pen2: () => this.setPen(1),
      pen3: () => this.setPen(2),
      highlighter: () => this.setTool('highlighter'),
      eraser: () => this.setTool('eraser'),
      lasso: () => this.setTool('lasso'),
      shape: () => this.setTool('shape'),
      note: () => this.insertNote(undefined, this.pointerOrCenter()),
      text: () => this.insertText(this.pointerOrCenter()),
    };
    const pressed = normalizeKey(key);
    const action = KEY_ACTIONS.find((a) => this.keys[a.id] === pressed);
    if (action) {
      e.preventDefault();
      actions[action.id]();
    }
  }

  // ---------------------------------------------------------------- settings

  /** Bind a key to an action. Any other action using that key is unbound. */
  setKeyBinding(action: KeyAction, key: string) {
    const k = normalizeKey(key);
    for (const a of KEY_ACTIONS) if (this.keys[a.id] === k) this.keys[a.id] = '';
    this.keys[action] = k;
    this.savePrefs();
    this.emitChange();
  }

  resetKeyBindings() {
    this.keys = { ...DEFAULT_KEYS };
    this.savePrefs();
    this.emitChange();
  }

  setImageQuality(q: ImageQuality) {
    this.imageQuality = q;
    this.savePrefs();
  }

  setDynamicInk(on: boolean) {
    this.dynamicInk = on;
    this.savePrefs();
    this.emitChange();
  }

  private onCopy(e: ClipboardEvent, cut: boolean) {
    if (this.opts.acceptClipboard && !this.opts.acceptClipboard(cut ? 'cut' : 'copy')) return;
    if (isTypingTarget(document.activeElement) || !this.selection.size || !e.clipboardData || (cut && this.readOnly)) return;
    const elements = this.selectedEls();
    const assets = referencedAssets(elements, this.doc.assets);
    e.clipboardData.setData('text/plain', CLIP_MARK + JSON.stringify({ elements, assets }));
    e.preventDefault();
    if (cut) this.deleteSelection();
  }

  private onPaste(e: ClipboardEvent) {
    if (this.opts.acceptClipboard && !this.opts.acceptClipboard('paste')) return;
    if (isTypingTarget(document.activeElement) || !e.clipboardData || this.readOnly) return;
    const at = this.pointerOrCenter();
    const pdfs = [...e.clipboardData.files].filter(isPdfFile);
    if (pdfs.length && this.onPdf) {
      e.preventDefault();
      pdfs.forEach((f) => this.onPdf?.(f));
      return;
    }
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      files.forEach((f, i) => void this.insertImageFile(f, { x: at.x + i * 30, y: at.y + i * 30 }));
      return;
    }
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    if (text.startsWith(CLIP_MARK)) {
      try {
        const data = JSON.parse(text.slice(CLIP_MARK.length));
        void this.pasteElements(sanitizeElements(data.elements), sanitizeAssets(data.assets), at);
      } catch {
        this.onError('Could not paste those items');
      }
      return;
    }
    this.insertText(at, text.slice(0, 20000));
  }

  /** Put copies of items from another board (with their images) in the middle of this board's view. */
  importElements(els: El[], assets: Record<string, string>): Promise<void> {
    return this.pasteElements(sanitizeElements(els), sanitizeAssets(assets), this.viewCenter);
  }

  private async pasteElements(els: El[], assets: Record<string, string>, at: Pt) {
    const usable = els.filter((e) => e.type !== 'image' || assets[e.asset] || this.doc.assets[e.asset]);
    const b = unionBounds(usable.map(boundsOf));
    if (!b) return;
    const newBytes = Object.entries(assets).reduce((sum, [id, src]) => sum + (this.doc.assets[id] ? 0 : src.length * 0.75), 0);
    if (newBytes && !(await this.hasRoomFor(newBytes))) return;
    const fresh = Object.fromEntries(Object.entries(assets).filter(([id]) => !this.doc.assets[id] && usable.some((e) => e.type === 'image' && e.asset === id)));
    if (Object.keys(fresh).length && this.beforeNewAssets && !(await this.beforeNewAssets(fresh))) return;
    Object.assign(this.doc.assets, assets);
    const dx = at.x - (b.x + b.w / 2), dy = at.y - (b.y + b.h / 2);
    this.addElements(usable.map((e) => ({ ...translateEl(e, dx, dy), id: uid() })));
  }

  private onDrop(e: DragEvent) {
    if (this.readOnly) return;
    const dropped = [...(e.dataTransfer?.files ?? [])];
    const pdfs = this.onPdf ? dropped.filter(isPdfFile) : [];
    const files = dropped.filter((f) => f.type.startsWith('image/'));
    if (!files.length && !pdfs.length) return;
    e.preventDefault();
    pdfs.forEach((f) => this.onPdf?.(f));
    const at = this.screenToWorld(this.screenPoint(e));
    files.forEach((f, i) => void this.insertImageFile(f, { x: at.x + i * 30, y: at.y + i * 30 }));
  }

  // ---------------------------------------------------------------- cursor

  private updateCursor() {
    let cursor: string;
    if (this.spaceDown || (this.readOnly && !(this.copyOnly && this.tool === 'select'))) cursor = 'grab';
    else if (this.tool === 'pen' || this.tool === 'highlighter') {
      // A dot the size and color of the ink at the current zoom.
      const ink = this.tool === 'pen' ? this.pens[this.penIndex] : this.highlighter;
      cursor = circleCursor(ink.size * this.cam.zoom, ink.color, ink.opacity);
    } else if (this.tool === 'eraser') {
      cursor = this.eraser.mode === 'area' ? squareCursor(this.eraser.size) : circleCursor(this.eraser.size, '#ffffff', 0.6);
    }
    else cursor = { select: 'default', hand: 'grab', lasso: 'crosshair', shape: 'crosshair' }[this.tool];
    // Skip re-assigning an unchanged cursor, since this runs on every pan and zoom step.
    if (cursor === this.cursorKey) return;
    this.cursorKey = cursor;
    this.canvas.style.cursor = cursor;
  }

  private updateHoverCursor(sp: Pt, wp: Pt) {
    if (this.spaceDown || this.readOnly) return;
    if (this.tool === 'select' || this.tool === 'lasso') {
      const angle = this.screenFrame()?.angle ?? 0;
      const hd = this.handleAt(sp);
      if (hd) {
        this.canvas.style.cursor = resizeCursor(hd, angle);
        return;
      }
      const corner = this.rotateCornerAt(sp);
      if (corner) {
        this.canvas.style.cursor = rotateCursor(corner, angle);
        return;
      }
      if (this.inSelectionBox(wp) || (this.tool === 'select' && this.hitAt(wp))) {
        this.canvas.style.cursor = 'move';
        return;
      }
    }
    this.updateCursor();
  }

  // ---------------------------------------------------------------- rendering

  requestRender() {
    if (this.frame || this.destroyed) return;
    this.frame = requestAnimationFrame(() => this.render());
  }

  private render() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.destroyed) return;
    // A turned selection box is forgotten as soon as nothing is selected.
    if (!this.selection.size) this.turned = null;
    // Picking something means looking around on your own now.
    if (this.followMode !== 'off' && this.selection.size) this.disturbFollow('select');
    // Following the owner moves the camera, so it comes before anything is drawn with it.
    const following = this.stepFollowView();
    const { ctx, dpr, cam } = this;
    const z = cam.zoom;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBackground(ctx, this.doc.background, cam, this.width, this.height);

    ctx.setTransform(dpr * z, 0, 0, dpr * z, -cam.x * z * dpr, -cam.y * z * dpr);
    const opts: DrawOpts = { images: this.images, assets: this.doc.assets, editingId: this.editing?.id };
    const moving = this.stepSmoothing() || following;
    if (this.smooth.offsets.size) this.drawElementsSmoothed(ctx, opts);
    else drawElements(ctx, this.doc.elements, this.viewBounds(), opts);
    const st = this.state;
    this.drawRemoteStrokes(ctx, opts);
    if (st?.kind === 'draw') drawElement(ctx, st.el, opts);
    if (st?.kind === 'create' && st.el) drawElement(ctx, st.el, opts);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawOverlay(ctx);
    this.drawRemotePeople(ctx);
    this.positionEditor();
    this.renderListeners.forEach((fn) => fn());
    // Keep drawing while others' cursors, strokes or moved items are still catching up.
    if (moving) this.requestRender();
  }

  /** Strokes other people are drawing right now, slightly faded until they're finished. */
  private drawRemoteStrokes(ctx: CanvasRenderingContext2D, opts: DrawOpts) {
    for (const p of this.remote) {
      const s = p.stroke;
      if (!s || s.points.length < 3) continue;
      const shown = Math.max(1, Math.floor(this.smooth.strokes.get(p.id)?.shown ?? s.points.length / 3));
      ctx.globalAlpha = 0.7;
      drawElement(ctx, {
        type: 'stroke', id: `remote-${p.id}`, points: s.points.slice(0, shown * 3), color: s.color, size: s.size,
        highlighter: s.highlighter || undefined, opacity: s.opacity,
      }, opts);
      ctx.globalAlpha = 1;
    }
  }

  /** Other people's selections, the text they're editing, and their cursors with name tags. */
  private drawRemotePeople(ctx: CanvasRenderingContext2D) {
    if (!this.remote.length) return;
    const tag = (text: string, x: number, y: number, color: string) => {
      ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
      const w = ctx.measureText(text).width + 12;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(x, y, w, 20, 6);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x + 6, y + 10.5);
    };
    for (const p of this.remote) {
      const ids = new Set(p.editing ? [...p.selection, p.editing] : p.selection);
      const els = ids.size ? this.doc.elements.filter((e) => ids.has(e.id)) : [];
      // Outlines follow the smoothed positions of what they're selecting.
      const b = els.length ? unionBounds(els.map((el) => {
        const eb = boundsOf(el);
        const o = this.smooth.offsets.get(el.id);
        return o ? { ...eb, x: eb.x + o.dx, y: eb.y + o.dy } : eb;
      })) : null;
      if (b) {
        const r = this.toScreenRect(b);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2;
        ctx.setLineDash(p.editing ? [] : [6, 4]);
        ctx.strokeRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6);
        ctx.setLineDash([]);
        if (p.editing) tag(`${p.name} is typing`, r.x - 3, r.y - 26, p.color);
      }
      const cursor = this.smooth.cursors.get(p.id) ?? p.cursor;
      if (cursor) {
        const c = this.worldToScreen(cursor);
        if (c.x < -20 || c.y < -20 || c.x > this.width + 20 || c.y > this.height + 20) continue;
        ctx.globalAlpha = this.cursorAlpha(p.id);
        if (p.tool) drawToolCursor(ctx, c, p.tool, p.color);
        else drawArrowCursor(ctx, c, p.color);
        // The tool pictures are small, so their name tag sits closer than the arrow's.
        if (p.tool) tag(p.name, c.x + 8, c.y + 12, p.color);
        else tag(p.name, c.x + 10, c.y + 16, p.color);
        ctx.globalAlpha = 1;
      }
    }
  }

  private drawOverlay(ctx: CanvasRenderingContext2D) {
    const st = this.state;
    ctx.lineWidth = 1;
    ctx.strokeStyle = ACCENT;

    if (this.selection.size && st?.kind !== 'draw') {
      const els = this.selectedEls();
      if (els.length > 1) {
        ctx.globalAlpha = 0.45;
        for (const el of els) {
          const r = this.toScreenRect(boundsOf(el));
          ctx.strokeRect(r.x, r.y, r.w, r.h);
        }
        ctx.globalAlpha = 1;
      }
      const fr = this.screenFrame();
      if (fr) {
        ctx.lineWidth = 1.5;
        // Drawn upright around the origin, with the canvas turned to match.
        ctx.save();
        ctx.translate(fr.c.x, fr.c.y);
        ctx.rotate(fr.angle);
        ctx.strokeRect(-fr.w / 2, -fr.h / 2, fr.w, fr.h);
        if ((this.tool === 'select' || this.tool === 'lasso') && !this.editing) {
          ctx.fillStyle = '#ffffff';
          for (const p of Object.values(this.handlePoints({ x: 0, y: 0 }, fr.w, fr.h))) {
            ctx.fillRect(p.x - HANDLE_SIZE / 2, p.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
            ctx.strokeRect(p.x - HANDLE_SIZE / 2, p.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
          }
        }
        ctx.restore();
      }
    }

    if (st?.kind === 'rotate' && st.changed) {
      const sp = this.worldToScreen(this.lastPointerWorld ?? { x: st.frame.cx, y: st.frame.cy });
      const total = st.frame.angle + st.angle;
      const deg = Math.round(((((total * 180) / Math.PI) % 360) + 360) % 360);
      const label = `${deg}°`;
      ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
      const w = ctx.measureText(label).width + 12;
      ctx.fillStyle = ACCENT;
      ctx.beginPath();
      ctx.roundRect(sp.x + 14, sp.y + 14, w, 20, 6);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, sp.x + 20, sp.y + 24.5);
    }

    if (st?.kind === 'marquee') {
      const r = this.toScreenRect(normRect(st.start.x, st.start.y, st.cur.x - st.start.x, st.cur.y - st.start.y));
      ctx.fillStyle = 'rgba(47,111,222,0.08)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }

    if (st?.kind === 'erase') {
      const c = this.worldToScreen(st.last);
      const d = st.size;
      ctx.beginPath();
      if (this.eraser.mode === 'area') ctx.rect(c.x - d / 2, c.y - d / 2, d, d);
      else ctx.arc(c.x, c.y, d / 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.stroke();
    }

    if (st?.kind === 'lasso' && st.pts.length > 1) {
      ctx.beginPath();
      st.pts.forEach((p, i) => {
        const s = this.worldToScreen(p);
        if (i) ctx.lineTo(s.x, s.y);
        else ctx.moveTo(s.x, s.y);
      });
      ctx.fillStyle = 'rgba(47,111,222,0.06)';
      ctx.fill();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

// ---------------------------------------------------------------- other people's cursors

/** The usual pointer arrow, in the person's colour. */
function drawArrowCursor(ctx: CanvasRenderingContext2D, c: Pt, color: string) {
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.lineTo(c.x, c.y + 17);
  ctx.lineTo(c.x + 4.5, c.y + 12.5);
  ctx.lineTo(c.x + 11.5, c.y + 12.5);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/** How big the pictures of other people's tools are drawn. */
const TOOL_CURSOR_SCALE = 0.7;

/**
 * A small picture of the tool someone is holding, with its working end exactly at their cursor:
 * a pen or highlighter with a tip in its ink colour, an eraser, or a lasso or shape badge.
 */
function drawToolCursor(ctx: CanvasRenderingContext2D, c: Pt, tool: ToolInHand, personColor: string) {
  const outline = (w = 1.25) => {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = w;
    ctx.stroke();
  };
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.scale(TOOL_CURSOR_SCALE, TOOL_CURSOR_SCALE);
  if (tool.kind === 'pen' || tool.kind === 'highlighter') {
    // Held at an angle: the tip at the cursor, the body up and to the right.
    ctx.rotate(Math.PI / 4);
    const hl = tool.kind === 'highlighter';
    const w = hl ? 4.5 : 3.25;
    ctx.beginPath();
    if (hl) ctx.rect(-w, -7, w * 2, 7);
    else {
      ctx.moveTo(0, 0);
      ctx.lineTo(-w, -7);
      ctx.lineTo(w, -7);
      ctx.closePath();
    }
    ctx.fillStyle = tool.color;
    ctx.fill();
    outline();
    ctx.beginPath();
    ctx.rect(-w, -24, w * 2, 17);
    ctx.fillStyle = hl ? '#d6dae0' : '#2b2f36';
    ctx.fill();
    outline();
    // The end cap shows whose it is.
    ctx.beginPath();
    ctx.rect(-w, -28, w * 2, 4);
    ctx.fillStyle = personColor;
    ctx.fill();
    outline();
  } else if (tool.kind === 'eraser') {
    ctx.rotate(Math.PI / 4);
    ctx.beginPath();
    if (tool.mode === 'area') ctx.rect(-6, -8, 12, 8);
    else ctx.roundRect(-6, -8, 12, 8, [0, 0, 4, 4]);
    ctx.fillStyle = '#f2a7b8';
    ctx.fill();
    outline();
    ctx.beginPath();
    ctx.rect(-6, -22, 12, 14);
    ctx.fillStyle = personColor;
    ctx.fill();
    outline();
  } else {
    // Lasso and shapes are aimed precisely: a small crosshair, plus a badge for the tool.
    ctx.beginPath();
    ctx.moveTo(-6, 0);
    ctx.lineTo(6, 0);
    ctx.moveTo(0, -6);
    ctx.lineTo(0, 6);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.strokeStyle = personColor;
    ctx.lineWidth = 1.75;
    ctx.stroke();
    ctx.translate(9, -18);
    ctx.beginPath();
    if (tool.kind === 'lasso') ctx.ellipse(6, 5, 7, 4.5, 0, 0, Math.PI * 2);
    else {
      ctx.rect(0, 2, 7, 7);
      ctx.moveTo(15, 5.5);
      ctx.arc(11.5, 5.5, 3.5, 0, Math.PI * 2);
    }
    ctx.setLineDash(tool.kind === 'lasso' ? [3, 2] : []);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.strokeStyle = personColor;
    ctx.lineWidth = 1.75;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}
