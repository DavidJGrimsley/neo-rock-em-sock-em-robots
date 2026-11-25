// Patch 0005: controller grip-attached visuals, updated only on VROOpenXRRender.
// Included once after QuestInputSampler.h and QuestRigSync.h in the renderer TU.
#pragma once
#include "QuestHandsMath.h"

namespace quest_hands {
namespace m = quest_hands_math;
static std::atomic<bool> enabled{false};
static std::atomic<bool> visualNodesReady{false};
static const char *tags[6] = {"quest-left-upper", "quest-left-forearm", "quest-left-fist",
                             "quest-right-upper", "quest-right-forearm", "quest-right-fist"};
struct Cache {
    std::weak_ptr<VRONode> root;
    std::weak_ptr<VRONode> nodes[6];
    int64_t captured=0,applied=0,lastFrame=0,lastLog=0;
    int frames=0,visible=0,hidden=0;
    int meshNodes[2]={0,0},hiddenMeshNodes[2]={0,0},drawnMeshNodes[2]={0,0};
    long long predicted=0;
    int gripFlags[2]={0,0},gripActive[2]={0,0};
    std::vector<double> captureApply,applyRender,captureEyes,captureEnd,interval;
};
// Each renderer owns its cache on its render thread; an old session cannot reset a newer thread.
static thread_local Cache cache;
inline m::V vec(VROVector3f p) { return {p.x,p.y,p.z}; }
inline m::Q quat(VROQuaternion q) { return {q.X,q.Y,q.Z,q.W}; }
// VRTNode.handleAppearanceChange propagates parent disappearance to the GLB
// wrapper. Native root-only unhide cannot reverse that cached Java visibility.
// These six static derivatives are wholly owned cosmetic subtrees (no helpers).
inline void setSubtreeHidden(const std::shared_ptr<VRONode> &node,bool hidden) {
    if (!node) return;
    if (node->isHidden()!=hidden) node->setHidden(hidden);
    for (const auto &child:node->getChildNodes()) setSubtreeHidden(child,hidden);
}
inline void set(const std::shared_ptr<VRONode> &n,m::V p,m::Q q,float stretch=1) {
    if (!n) return;
    n->setPosition({p.x,p.y,p.z});
    n->setRotation(VROQuaternion(q.x,q.y,q.z,q.w));
    n->setScale({m::kScale,m::kScale,m::kScale*stretch});
    if (n->getOpacity()!=1) n->setOpacity(1);
    setSubtreeHidden(n,false);
}
inline void hide() {
    for (auto &w:cache.nodes) if (auto n=w.lock()) n->setHidden(true);
    cache.captured=cache.applied=cache.lastFrame=0;
}
// Release this thread's refs only, never mutate a VRONode off-thread.
// Render-thread exit also destroys its thread-local cache.
// Renderer session recreation must preserve the mounted JS lifecycle intent.
inline void reset() { cache=Cache{}; }
inline void apply(const std::shared_ptr<VRONode> &root,const QuestRawInput &raw,
                  XrTime frameTime,int sessionState) {
    cache.captured=0;
    // Ownership release must not keep hiding nodes driven by the ref fallback.
    // JS lifecycle cleanup queues root opacity zero; descendants stay logically live.
    if (!enabled.load(std::memory_order_relaxed)) { cache=Cache{}; return; }
    if (!root) { hide(); return; }
    if (cache.root.lock()!=root) { hide(); cache=Cache{}; cache.root=root; }
    for (int i=0;i<6;++i) {
        auto node=cache.nodes[i].lock();
        if (!node||!node->getParentNode()) cache.nodes[i]=quest_rig::findNodeByTag(root,tags[i]);
    }
    const int64_t now=quest_input::monotonicNow();
    const bool focused=sessionState==XR_SESSION_STATE_FOCUSED&&raw.syncResult==XR_SUCCESS&&raw.actionsReady;
    auto rig=quest_rig::renderCache.nodes[0].lock();
    auto blue=quest_rig::renderCache.nodes[3].lock();
    bool appliedPose=false;
    for (int side=0;side<2;++side) {
        const auto &grip=raw.grips[side];
        const auto flags=grip.locationFlags;
        cache.gripFlags[side]=static_cast<int>(flags); cache.gripActive[side]=grip.poseActive?1:0;
        const bool valid=XR_SUCCEEDED(grip.locateResult)&&
            (flags&XR_SPACE_LOCATION_POSITION_VALID_BIT)&&(flags&XR_SPACE_LOCATION_ORIENTATION_VALID_BIT);
        const bool fresh=m::fresh(focused,grip.poseActive,valid,raw.poseTime,frameTime,raw.capturedMonoNs,now);
        const auto &p=grip.pose.position; const auto &q=grip.pose.orientation;
        auto f=m::fist(side,{p.x,p.y,p.z},{q.x,q.y,q.z,q.w});
        auto upper=cache.nodes[side*3].lock(),forearm=cache.nodes[side*3+1].lock(),fist=cache.nodes[side*3+2].lock();
        if (!fresh||!f.visible) {
            if (upper) upper->setHidden(true);
            if (forearm) forearm->setHidden(true);
            if (fist) fist->setHidden(true);
            ++cache.hidden; continue;
        }
        if (fist) { appliedPose=true; ++cache.visible; }
        set(fist,f.wrist,f.rotation); // never clamp or hide a valid fist at arm reach limits
        bool armVisible=false;
        if (rig&&blue) {
            const auto rs=vec(rig->getScale()),bs=vec(blue->getScale());
            const auto rq=quat(rig->getRotation()),bq=quat(blue->getRotation());
            const auto shoulder=m::shoulder(vec(rig->getPosition()),rq,rs,
                                               vec(blue->getPosition()),bq,bs,side);
            const auto arm=m::arm(shoulder,f.wrist,f.rotation,m::mul(rq,bq),side);
            armVisible=arm.visible;
            if (arm.visible) { set(upper,shoulder,arm.upper,arm.stretch); set(forearm,f.wrist,arm.forearm,arm.stretch); }
        }
        if (!armVisible) { if (upper) upper->setHidden(true); if (forearm) forearm->setHidden(true); }
    }
    cache.captured=appliedPose?raw.capturedMonoNs:0; cache.applied=quest_input::monotonicNow();
    if (cache.captured>0&&cache.applied>=cache.captured) cache.captureApply.push_back((cache.applied-cache.captured)*1e-6);
}
inline double percentile(std::vector<double> values,double p) {
    if (values.empty()) return -1;
    std::sort(values.begin(),values.end());
    return values[std::min(values.size()-1,static_cast<size_t>(std::ceil(p*values.size())-1))];
}
// Immediately before first eye rendering. XrTime is logged separately, never subtracted from CLOCK_MONOTONIC.
inline void beforeEyes(XrTime predicted) {
    if (!enabled.load(std::memory_order_relaxed)) return;
    const int64_t now=quest_input::monotonicNow();
    cache.predicted=predicted;
    if (cache.captured>0&&cache.applied>0) {
        cache.applyRender.push_back((now-cache.applied)*1e-6);
        cache.captureEyes.push_back((now-cache.captured)*1e-6);
    }
    if (cache.lastFrame>0) cache.interval.push_back((now-cache.lastFrame)*1e-6);
    cache.lastFrame=now; ++cache.frames;
}
// Observe the actual loaded GLB geometry, including inherited opacity/culling,
// and entry into VRONode::render(element) this frame. A draw call is not pixel proof.
inline void inspectMeshes(const std::shared_ptr<VRONode> &node,int frame,int side) {
    if (!node) return;
    if (node->getGeometry()) {
        ++cache.meshNodes[side];
        if (node->isHidden()||node->getComputedOpacityForQuest()<=0.02f) ++cache.hiddenMeshNodes[side];
        if (node->getLastGeometryRenderFrameForQuest()==frame) ++cache.drawnMeshNodes[side];
    }
    for (const auto &child:node->getChildNodes()) inspectMeshes(child,frame,side);
}
// CPU eye-command submission end only: does not wait for GPU completion or photons.
inline void afterEyes(int frame) {
    if (!enabled.load(std::memory_order_relaxed)) return;
    for (int side=0;side<2;++side) {
        cache.meshNodes[side]=cache.hiddenMeshNodes[side]=cache.drawnMeshNodes[side]=0;
        inspectMeshes(cache.nodes[side*3+2].lock(),frame,side);
    }
    visualNodesReady.store(cache.meshNodes[0]>0&&cache.meshNodes[1]>0,std::memory_order_relaxed);
    const int64_t now=quest_input::monotonicNow();
    if (cache.captured>0) cache.captureEnd.push_back((now-cache.captured)*1e-6);
    if (cache.lastLog==0) cache.lastLog=now;
    if (now-cache.lastLog<2000000000LL) return;
    __android_log_print(ANDROID_LOG_INFO,"QuestHands",
        "grip predicted=%lld frames=%d poseApplied=%d rejected=%d activeL=%d flagsL=%d activeR=%d flagsR=%d captureApplyP50Ms=%.3f captureApplyP95Ms=%.3f applyEyesP95Ms=%.3f captureEyesStartP95Ms=%.3f captureEyesEndP95Ms=%.3f frameP95Ms=%.3f meshL=%d hiddenMeshL=%d drawnMeshL=%d meshR=%d hiddenMeshR=%d drawnMeshR=%d staleCapMs=50",
        cache.predicted,cache.frames,cache.visible,cache.hidden,cache.gripActive[0],cache.gripFlags[0],
        cache.gripActive[1],cache.gripFlags[1],percentile(cache.captureApply,.5),
        percentile(cache.captureApply,.95),percentile(cache.applyRender,.95),percentile(cache.captureEyes,.95),
        percentile(cache.captureEnd,.95),percentile(cache.interval,.95),
        cache.meshNodes[0],cache.hiddenMeshNodes[0],cache.drawnMeshNodes[0],
        cache.meshNodes[1],cache.hiddenMeshNodes[1],cache.drawnMeshNodes[1]);
    cache.lastLog=now; cache.frames=cache.visible=cache.hidden=0;
    cache.captureApply.clear(); cache.applyRender.clear(); cache.captureEyes.clear(); cache.captureEnd.clear(); cache.interval.clear();
}
} // namespace quest_hands

extern "C" JNIEXPORT jint JNICALL
Java_expo_modules_questinput_QuestInputModule_nativeHandsVersion(JNIEnv *,jobject) { return 1; }
extern "C" JNIEXPORT void JNICALL
Java_expo_modules_questinput_QuestInputModule_nativeSetHandsEnabled(JNIEnv *,jobject,jboolean active) {
    quest_hands::visualNodesReady.store(false,std::memory_order_relaxed);
    quest_hands::enabled.store(active==JNI_TRUE,std::memory_order_relaxed);
}
extern "C" JNIEXPORT jboolean JNICALL
Java_expo_modules_questinput_QuestInputModule_nativeHandsVisualNodesReady(JNIEnv *,jobject) {
    return quest_hands::visualNodesReady.load(std::memory_order_relaxed)?JNI_TRUE:JNI_FALSE;
}
