// Shared portable math for patch 0005 and host tests. Right-handed OpenXR LOCAL metres.
// Elbows are cosmetic two-bone estimates; no controller provides a tracked elbow.
#pragma once
#include <cmath>

namespace quest_hands_math {
struct V { float x, y, z; };
struct Q { float x, y, z, w; };
inline V add(V a, V b) { return {a.x+b.x,a.y+b.y,a.z+b.z}; }
inline V sub(V a, V b) { return {a.x-b.x,a.y-b.y,a.z-b.z}; }
inline V scale(V a, float s) { return {a.x*s,a.y*s,a.z*s}; }
inline float dot(V a, V b) { return a.x*b.x+a.y*b.y+a.z*b.z; }
inline V cross(V a, V b) { return {a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x}; }
inline float length(V a) { return std::sqrt(dot(a,a)); }
inline V unit(V a) { const float n=length(a); return n>1e-8f?scale(a,1/n):V{0,0,0}; }
inline bool finite(V p) { return std::isfinite(p.x)&&std::isfinite(p.y)&&std::isfinite(p.z); }
inline bool normalize(Q &q) {
    const float n=std::sqrt(q.x*q.x+q.y*q.y+q.z*q.z+q.w*q.w);
    if (!std::isfinite(n)||std::fabs(n-1)>0.05f) return false;
    q={q.x/n,q.y/n,q.z/n,q.w/n}; return true;
}
// Explicit Hamilton product: VROQuaternion's operator* uses the reverse order.
inline Q mul(Q a,Q b) {
    return {a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y,
            a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,
            a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w,
            a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z};
}
inline V rotate(Q q,V p) {
    const V u{q.x,q.y,q.z}; const V t=scale(cross(u,p),2);
    return add(p,add(scale(t,q.w),cross(u,t)));
}
constexpr float kFighterScale=0.12f/1.59857170559f;
constexpr float kScale=kFighterScale*16.0f; // fighterScale 0.07506875 * worldScale 16
// quest-blue-node is an unscaled parent; fighterScale lives on its mesh children.
inline V shoulder(V rigPos,Q rigRotation,V rigScale,V bodyPos,Q bodyRotation,V bodyScale,int side) {
    const V joint=scale({side==0?0.127665097f:-0.127665068f,0.83775128f,0.135874959f},kFighterScale);
    const V local=add(bodyPos,rotate(bodyRotation,{joint.x*bodyScale.x,joint.y*bodyScale.y,joint.z*bodyScale.z}));
    return add(rigPos,rotate(rigRotation,{local.x*rigScale.x,local.y*rigScale.y,local.z*rigScale.z}));
}
// Mesh +X is left thumb, -X right thumb; -Z is the knuckle/punch axis.
// Grip -Z runs little finger -> thumb; grip -Y is the knuckle direction.
// Both proper rotations map the anatomical thumb to grip -Z, without mirroring.
inline Q meshToGrip(int side) {
    return side==0?Q{-0.5f,0.5f,0.5f,0.5f}:Q{-0.5f,-0.5f,-0.5f,0.5f};
}
inline V palmCenter(int side) {
    // Halfway from source wrist to midpoint(index_01,pinky_01), in baked mesh space.
    return side==0?V{0.000395137f,-0.005049033f,-0.068952912f}:
                   V{-0.000395141f,-0.005049129f,-0.068952916f};
}
struct Fist { V wrist; Q rotation; bool visible; };
inline bool fresh(bool focused,bool active,bool valid,long long poseTime,long long frameTime,
                  long long captured,long long now) {
    return focused&&active&&valid&&poseTime==frameTime&&captured>0&&now>=captured&&now-captured<=50000000LL;
}
inline Fist fist(int side,V grip,Q orientation) {
    if (!finite(grip)||!normalize(orientation)) return {{0,0,0},{0,0,0,1},false};
    const Q rotation=mul(orientation,meshToGrip(side));
    return {sub(grip,rotate(rotation,scale(palmCenter(side),kScale))),rotation,true};
}
inline Q basis(V z,V up) {
    V y=sub(up,scale(z,dot(up,z)));
    if (length(y)<1e-6f) {
        const V fallback=std::fabs(z.y)<0.9f?V{0,1,0}:V{1,0,0};
        y=sub(fallback,scale(z,dot(fallback,z)));
    }
    y=unit(y); const V x=unit(cross(y,z)); y=unit(cross(z,x));
    Q q{}; const float trace=x.x+y.y+z.z;
    if (trace>0) { const float s=std::sqrt(trace+1)*2; q={(y.z-z.y)/s,(z.x-x.z)/s,(x.y-y.x)/s,s/4}; }
    else if (x.x>y.y&&x.x>z.z) { const float s=std::sqrt(1+x.x-y.y-z.z)*2; q={s/4,(y.x+x.y)/s,(z.x+x.z)/s,(y.z-z.y)/s}; }
    else if (y.y>z.z) { const float s=std::sqrt(1+y.y-x.x-z.z)*2; q={(y.x+x.y)/s,s/4,(z.y+y.z)/s,(z.x-x.z)/s}; }
    else { const float s=std::sqrt(1+z.z-x.x-y.y)*2; q={(z.x+x.z)/s,(z.y+y.z)/s,s/4,(x.y-y.x)/s}; }
    normalize(q); return q;
}
struct Arm { V elbow; Q upper,forearm; float stretch; bool visible; };
inline Arm arm(V shoulder,V wrist,Q fistRotation,Q bodyRotation,int side) {
    const float l1=0.218699927f*kScale,l2=0.188133323f*kScale;
    const V delta=sub(wrist,shoulder); const float d=length(delta),reach=l1+l2;
    if (!finite(shoulder)||!finite(wrist)||d<1e-4f||d>2.05f*reach) return {{0,0,0},{0,0,0,1},{0,0,0,1},1,false};
    const float stretch=d>0.94f*reach?std::fmin(2.05f,d/(0.94f*reach)):1;
    const float a=l1*stretch,b=l2*stretch;
    const V dir=unit(delta),pole=rotate(bodyRotation,unit({side==0?0.45f:-0.45f,-1,-0.25f}));
    V bend=sub(pole,scale(dir,dot(pole,dir)));
    if (length(bend)<1e-5f) bend=sub(V{0,-1,0},scale(dir,-dir.y));
    if (length(bend)<1e-5f) bend=sub(V{1,0,0},scale(dir,dir.x));
    const float along=(a*a-b*b+d*d)/(2*d);
    const V elbow=add(add(shoulder,scale(dir,along)),scale(unit(bend),std::sqrt(std::fmax(0,a*a-along*along))));
    return {elbow,basis(unit(sub(shoulder,elbow)),scale(pole,-1)),
            basis(unit(sub(elbow,wrist)),rotate(fistRotation,{0,1,0})),stretch,true};
}
} // namespace quest_hands_math
