import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import {
  ViroBox,
  ViroMaterials,
  ViroNode,
  ViroQuad,
  ViroSphere,
  ViroText,
} from '@reactvision/react-viro';

import { questInputAvailable, questInputNative } from '../../../modules/quest-input/src/index.ts';
import {
  QUEST_DIAG_POSE,
  QUEST_DIAG_SIZE,
  QUEST_DIAG_TEXTURE,
  buildQuestDiagnosticsLivePatch,
  buildQuestDiagnosticsPanel,
  formatQuestDiagnosticsFallback,
  handLiveSignature,
  questDiagPanelPose,
} from './quest-diagnostics-layout.ts';
import { menuFrame } from './quest-head-rig.ts';
import type { QuestHeadTrackerSnapshot } from './quest-head-tracker.ts';
import {
  viroEulerDegrees,
  type QuestHand,
  type QuestHandSample,
  type QuestInputSample,
} from './quest-input.ts';
import {
  createQuestInputSource,
  type QuestHandStats,
  type QuestInputSource,
} from './quest-input-source.ts';
import {
  createQuestMenuCompositor,
  questMenuLayerVisible,
  type QuestMenuLayerSnapshot,
} from './quest-menu-compositor.ts';
import { questMenuLayer } from './quest-menu-layer.ts';
import type { QuestMenuFonts } from './quest-menu-layout.ts';

// Stage 04 controller diagnostics: world-space hand markers plus a large 45-degree
// sky diagnostics OpenXR quad layer. On patched Quest renderers, markers move directly
// on the OpenXR render thread inside renderFrame() with zero JS/bridge lag; phones
// and unpatched renderers fall back to setNativeProps. Live stick/trigger/grip/button
// indicators patch dirty sub-regions at ~10 Hz (immediate on button/tracking edges)
// outside React, while React state/telemetry updates stay at 5 Hz. Every geometry
// ignores events so Viro's hit test passes through to the menu.

ViroMaterials.createMaterials({
  questInputLeft: { diffuseColor: '#38bdf8', lightingModel: 'Constant' },
  questInputRight: { diffuseColor: '#f97316', lightingModel: 'Constant' },
  questInputRay: { diffuseColor: '#e2e8f0', lightingModel: 'Constant' },
  questInputInferred: { diffuseColor: '#facc15', lightingModel: 'Constant' },
});

const MARKER_RADIUS = 0.012;
const RAY_LENGTH = 0.15;
const FALLBACK_TEXT_SCALE = 0.05;
/** Cap analog Canvas patch cadence (~10 Hz, 100 ms) so live controls stay readable without GPU glFlush pressure. */
export const QUEST_DIAG_PATCH_ANALOG_MS = 100;
export const QUEST_DIAG_PATCH_EDGE_MS = 16;
const QUEST_DIAG_FULL_PRESENT_MIN_MS = 1000;

const diagFallbackStyle = {
  fontFamily: 'ArenaNotoSans',
  fontSize: 18,
  color: '#f8fafc',
  textAlign: 'left' as const,
  textAlignVertical: 'top' as const,
};

const now = () => globalThis.performance?.now?.() ?? Date.now();

/** One source per mounted scene. Null reader on phones and renderers without patch 0003. */
export function createSceneQuestInputSource(): QuestInputSource {
  return createQuestInputSource({
    reader: questInputAvailable() ? questInputNative : null,
    now,
    schedule: (cb, ms) => setTimeout(cb, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    // console.warn reaches logcat as ReactNativeJS in release builds.
    log: (message) => console.warn(`[QuestInput] ${message}`),
  });
}

type NodeRef = RefObject<ViroNode | null>;

interface MarkerState {
  visible: boolean;
  inferred: boolean;
}

function setNodeProps(ref: NodeRef, props: Record<string, unknown>) {
  ref.current?.setNativeProps(props as Parameters<ViroNode['setNativeProps']>[0]);
}

function HandMarker({
  hand,
  node,
  inferred,
}: {
  hand: QuestHand;
  node: NodeRef;
  inferred: NodeRef;
}) {
  return (
    <ViroNode ref={node} visible={false}>
      <ViroSphere
        radius={MARKER_RADIUS}
        materials={[hand === 'left' ? 'questInputLeft' : 'questInputRight']}
        ignoreEventHandling
      />
      {/* Aim pose -Z, the direction of Viro's own aim ray. */}
      <ViroBox
        position={[0, 0, -RAY_LENGTH / 2]}
        width={0.003}
        height={0.003}
        length={RAY_LENGTH}
        materials={['questInputRay']}
        ignoreEventHandling
      />
      <ViroNode ref={inferred} visible={false} position={[0, MARKER_RADIUS * 2.2, 0]}>
        <ViroBox
          width={0.01}
          height={0.01}
          length={0.01}
          materials={['questInputInferred']}
          ignoreEventHandling
        />
      </ViroNode>
    </ViroNode>
  );
}

/**
 * World-space markers; mounted at the ViroScene root in OpenXR LOCAL.
 * Uses zero-lag C++ render-thread markers on patched Quest renderers and falls back
 * to JS setNativeProps updates only on phones/unpatched renderers.
 */
export function QuestInputMarkers({
  source,
  onPipelineChange,
}: {
  source: QuestInputSource;
  onPipelineChange?: (pipeline: 'render-thread' | 'js-fallback') => void;
}) {
  const leftNode = useRef<ViroNode | null>(null);
  const leftInferred = useRef<ViroNode | null>(null);
  const rightNode = useRef<ViroNode | null>(null);
  const rightInferred = useRef<ViroNode | null>(null);

  useEffect(() => {
    let usingNative = false;
    try {
      usingNative = questInputAvailable() && questInputNative?.setMarkersEnabled?.(true) === true;
    } catch {
      usingNative = false;
    }
    onPipelineChange?.(usingNative ? 'render-thread' : 'js-fallback');
    if (usingNative) {
      return () => {
        try {
          questInputNative?.setMarkersEnabled?.(false);
        } catch {
          // Ignore teardown errors if native module unloads.
        }
      };
    }

    const markers: Record<QuestHand, { node: NodeRef; inferredNode: NodeRef } & MarkerState> = {
      left: { node: leftNode, inferredNode: leftInferred, visible: false, inferred: false },
      right: { node: rightNode, inferredNode: rightInferred, visible: false, inferred: false },
    };
    const place = (h: QuestHandSample | null, hand: QuestHand) => {
      const state = markers[hand];
      const visible = !!h && h.tracking !== 'lost' && !!h.position && !!h.orientation;
      if (visible && h?.position && h.orientation) {
        // One native update per hand per poll; visibility only changes on edges.
        setNodeProps(state.node, {
          position: [...h.position],
          rotation: [...viroEulerDegrees(h.orientation)],
          ...(visible !== state.visible ? { visible } : {}),
        });
      } else if (visible !== state.visible) {
        setNodeProps(state.node, { visible });
      }
      state.visible = visible;
      const isInferred = visible && h?.tracking === 'inferred';
      if (isInferred !== state.inferred) {
        setNodeProps(state.inferredNode, { visible: isInferred });
        state.inferred = isInferred;
      }
    };
    // Polls outpace frames; only a new sample (or none) moves or hides the markers.
    let placedSeq: number | null = null;
    return source.onSample((sample) => {
      if (sample && sample.seq === placedSeq) return;
      placedSeq = sample?.seq ?? null;
      place(sample?.left ?? null, 'left');
      place(sample?.right ?? null, 'right');
    });
  }, [onPipelineChange, source]);

  return (
    <>
      <HandMarker hand="left" node={leftNode} inferred={leftInferred} />
      <HandMarker hand="right" node={rightNode} inferred={rightInferred} />
    </>
  );
}

function buttonEdge(prev: QuestHandSample | null, next: QuestHandSample | null): boolean {
  if (!prev || !next) return prev !== next;
  return (
    prev.tracking !== next.tracking ||
    prev.buttons.primary !== next.buttons.primary ||
    prev.buttons.secondary !== next.buttons.secondary ||
    prev.buttons.menu !== next.buttons.menu
  );
}

export interface QuestDiagnosticsPanelProps {
  source: QuestInputSource;
  tracker: QuestHeadTrackerSnapshot;
  developerLines: readonly string[];
  fonts?: QuestMenuFonts;
  menuLayer?: QuestMenuLayerSnapshot;
  markerPipeline?: 'render-thread' | 'js-fallback';
}

/**
 * Large 2048x1152 sky diagnostics OpenXR quad layer anchored in menuFrame(cal)
 * at [0, 1.27, -1.27] pitched 45 deg toward the viewer, visible in both menu and ring.
 */
export function QuestDiagnosticsPanel({
  source,
  tracker,
  developerLines,
  fonts,
  menuLayer,
  markerPipeline,
}: QuestDiagnosticsPanelProps) {
  const input = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const [compositor] = useState(() =>
    createQuestMenuCompositor(
      {
        available: () =>
          typeof questInputNative?.openDiagnostics === 'function' &&
          typeof questInputNative?.drawDiagnostics === 'function' &&
          typeof questInputNative?.statusDiagnostics === 'function' &&
          typeof questInputNative?.hideDiagnostics === 'function' &&
          questInputAvailable(),
        open: () => {
          if (!questInputNative?.openDiagnostics) {
            throw new Error('QuestInput diagnostics layer unavailable.');
          }
          return questInputNative.openDiagnostics();
        },
        draw: (owner, spec) => questInputNative?.drawDiagnostics?.(owner, spec),
        status: (owner) => questInputNative?.statusDiagnostics?.(owner) ?? -1,
        hide: (owner) => questInputNative?.hideDiagnostics?.(owner),
        log: (level, message) => {
          if (level === 'error') console.error(`QuestDiagPanel ${message}`);
          else console.warn(`QuestDiagPanel ${message}`);
        },
      },
      { enabled: questMenuLayer.get() === 'compositor' }
    )
  );
  const diagLayer = useSyncExternalStore(compositor.subscribe, compositor.getSnapshot);
  const liveRef = useRef<{
    sample: QuestInputSample | null;
    hands: { left: QuestHandStats; right: QuestHandStats };
  } | null>(null);
  const patchStateRef = useRef<{
    lastPatchAt: number;
    leftCtrl: string;
    leftBadge: string;
    rightCtrl: string;
    rightBadge: string;
    lastSample: QuestInputSample | null;
  }>({
    lastPatchAt: 0,
    leftCtrl: '',
    leftBadge: '',
    rightCtrl: '',
    rightBadge: '',
    lastSample: null,
  });

  useEffect(() => () => compositor.dispose(), [compositor]);

  // Fast live indicator patch channel outside React: updates stick, trigger, grip,
  // buttons and tracking badge via dirty-region Canvas draws at ~10 Hz (immediate on edges).
  useEffect(() => {
    const canPatch =
      questMenuLayerVisible(diagLayer.mode) &&
      typeof questInputNative?.patchDiagnostics === 'function';
    if (!canPatch) return;
    return source.onSample((sample) => {
      const owner = compositor.getOwner();
      if (owner === null) return;
      const live = source.getLiveState?.() ?? {
        latest: sample,
        hands: source.getSnapshot().hands,
      };
      liveRef.current = { sample: live.latest ?? sample, hands: live.hands };
      const curSample = liveRef.current.sample;
      const leftSig = handLiveSignature(curSample?.left ?? null, live.hands.left);
      const rightSig = handLiveSignature(curSample?.right ?? null, live.hands.right);
      const st = patchStateRef.current;
      const leftCtrlDirty = leftSig.controlsKey !== st.leftCtrl;
      const leftBadgeDirty = leftSig.trackingKey !== st.leftBadge;
      const rightCtrlDirty = rightSig.controlsKey !== st.rightCtrl;
      const rightBadgeDirty = rightSig.trackingKey !== st.rightBadge;
      if (!leftCtrlDirty && !leftBadgeDirty && !rightCtrlDirty && !rightBadgeDirty) return;

      const t = now();
      const edge =
        buttonEdge(st.lastSample?.left ?? null, curSample?.left ?? null) ||
        buttonEdge(st.lastSample?.right ?? null, curSample?.right ?? null);
      const minGap = edge ? QUEST_DIAG_PATCH_EDGE_MS : QUEST_DIAG_PATCH_ANALOG_MS;
      if (st.lastPatchAt > 0 && t - st.lastPatchAt < minGap) return;

      const patch = buildQuestDiagnosticsLivePatch({
        sample: curSample,
        hands: live.hands,
        fonts,
        includeHands: {
          leftControls: leftCtrlDirty,
          leftBadge: leftBadgeDirty,
          rightControls: rightCtrlDirty,
          rightBadge: rightBadgeDirty,
        },
      });
      if (patch.regions.length === 0) return;
      st.lastPatchAt = t;
      st.leftCtrl = leftSig.controlsKey;
      st.leftBadge = leftSig.trackingKey;
      st.rightCtrl = rightSig.controlsKey;
      st.rightBadge = rightSig.trackingKey;
      st.lastSample = curSample;
      questInputNative?.patchDiagnostics?.(owner, JSON.stringify(patch));
    });
  }, [compositor, diagLayer.mode, fonts, source]);

  const panel = useMemo(
    () =>
      buildQuestDiagnosticsPanel({
        input,
        tracker,
        developerLines,
        fonts,
        menuLayer,
        diagLayerMode: diagLayer.mode,
        markerPipeline,
      }),
    [developerLines, diagLayer.mode, fonts, input, markerPipeline, menuLayer, tracker]
  );

  const fullPresentRef = useRef<{ at: number; structuralKey: string }>({
    at: 0,
    structuralKey: '',
  });

  useEffect(() => {
    const structuralKey = JSON.stringify([
      input.status,
      input.message,
      tracker.status,
      tracker.calibration,
      developerLines,
      diagLayer.mode,
      markerPipeline,
      fonts,
      menuLayer?.mode,
      menuLayer?.reason,
    ]);
    const t = now();
    const prev = fullPresentRef.current;
    if (
      prev.at > 0 &&
      prev.structuralKey === structuralKey &&
      t - prev.at < QUEST_DIAG_FULL_PRESENT_MIN_MS
    ) {
      return;
    }
    fullPresentRef.current = { at: t, structuralKey };

    const live = liveRef.current;
    const useLive = live && (!input.latest || (live.sample && live.sample.seq >= input.latest.seq));
    const sample = useLive ? live.sample : input.latest;
    const hands = useLive ? live.hands : input.hands;
    const leftSig = handLiveSignature(sample?.left ?? null, hands.left);
    const rightSig = handLiveSignature(sample?.right ?? null, hands.right);
    patchStateRef.current.leftCtrl = leftSig.controlsKey;
    patchStateRef.current.leftBadge = leftSig.trackingKey;
    patchStateRef.current.rightCtrl = rightSig.controlsKey;
    patchStateRef.current.rightBadge = rightSig.trackingKey;
    patchStateRef.current.lastSample = sample;

    const activePanel = useLive
      ? buildQuestDiagnosticsPanel({
          input,
          tracker,
          developerLines,
          fonts,
          menuLayer,
          diagLayerMode: diagLayer.mode,
          markerPipeline,
          liveSample: sample,
          liveHands: hands,
        })
      : panel;

    compositor.present({
      label: `diag ${input.status} ${tracker.status}`,
      pose: questDiagPanelPose(tracker.calibration).pose,
      ops: activePanel.ops,
      widthPx: QUEST_DIAG_TEXTURE.widthPx,
      heightPx: QUEST_DIAG_TEXTURE.heightPx,
      widthM: QUEST_DIAG_SIZE.widthM,
      heightM: QUEST_DIAG_SIZE.heightM,
    });
  }, [
    compositor,
    developerLines,
    diagLayer.mode,
    fonts,
    input,
    markerPipeline,
    menuLayer,
    panel,
    tracker,
  ]);

  const frame = menuFrame(tracker.calibration);
  const layerVisible = questMenuLayerVisible(diagLayer.mode);

  return (
    <ViroNode position={[...frame.position]} rotation={[0, frame.rotationY, 0]}>
      <ViroNode position={QUEST_DIAG_POSE.position} rotation={QUEST_DIAG_POSE.rotation}>
        {layerVisible ? (
          <ViroQuad
            width={QUEST_DIAG_SIZE.widthM}
            height={QUEST_DIAG_SIZE.heightM}
            materials={['questDiagLayerMask']}
            renderingOrder={-100}
            ignoreEventHandling
          />
        ) : (
          <>
            <ViroQuad
              width={QUEST_DIAG_SIZE.widthM}
              height={QUEST_DIAG_SIZE.heightM}
              materials={['questDiagBacking']}
              ignoreEventHandling
            />
            <ViroText
              text={formatQuestDiagnosticsFallback({
                input,
                tracker,
                developerLines,
                fonts,
                menuLayer,
                diagLayerMode: diagLayer.mode,
                markerPipeline,
              })}
              position={[0, 0, 0.004]}
              scale={[FALLBACK_TEXT_SCALE, FALLBACK_TEXT_SCALE, FALLBACK_TEXT_SCALE]}
              width={(QUEST_DIAG_SIZE.widthM * 0.92) / FALLBACK_TEXT_SCALE}
              height={(QUEST_DIAG_SIZE.heightM * 0.9) / FALLBACK_TEXT_SCALE}
              style={diagFallbackStyle}
              ignoreEventHandling
            />
          </>
        )}
      </ViroNode>
    </ViroNode>
  );
}
