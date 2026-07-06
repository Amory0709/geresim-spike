# 验证报告 — ClearView 还原度审查

**审查者:** verifier subagent
**审查日期:** 2026-07-06
**审查对象:** subagent A 产出 (commit `1fcbc35..7e41c16`)
**对照基线:** `/tmp/HexVolumeRenderer/Data/Shaders/`
**审查方法:** 行级 diff + 算法等价性分析 + JS 语法检查 (`node --check`)

---

## 总评

**8/9 ✅ + 1 ⚠️**

A 的整体还原度相当扎实:9 个组件里有 8 个与原参考**算法等价**(不一定字面一致,但数学步骤一致),只有 **第 7 项(atomic fragment insertion)存在一个真正的并发竞争 bug**——`imageLoad` + `imageAtomicExchange` 两步走,在多个 fragment 落到同一像素时可能让链表断链。

另外:**第 5 项(edge coverage)核心公式 ✅**,但 A 在外围 line-rendering 阶段**简化了视觉细节**——去掉了 outline 高亮、depth cue、ACCENTUATE_ALL_EDGES 二次 pass。这些不算组件 5 的硬性内容,但会在视觉上让 focus 区域的边线没有参考那种"白色描边"的对比效果。

`docs/verification.md`(A 自己的初报)整体写得不错,但**漏报了第 7 项的竞争条件**,也**漏报了第 5 项的视觉简化**。

---

## 组件逐项

### 1. `getDistanceToLineSegment` ✅

**A 实现:** `src/shaders/point-to-line-distance.glsl` line 19-37
**参考:** `Utils/PointToLineDistance.glsl` line 18-37

**逐行对比:** A 与参考**字面一致**,只是去掉了参考的 `See: http://geomalgorithms.com/a02-_lines.html` 注释。算法完全相同:

```glsl
// A 和参考一致
vec3 v = l1 - l0;
vec3 w = p - l0;
float c1 = dot(v, w);
if (c1 <= 0.0) return length(p - l0);       // 端点 0 一侧
float c2 = dot(v, v);
if (c2 <= c1) return length(p - l1);         // 端点 1 一侧
float b = c1 / c2;
vec3 pb = l0 + b * v;
return length(p - pb);                       // 垂直投影
```

**判定:** ✅ 算法等价,字面一致

---

### 2. `raySphereIntersection` + sphere 投影 ✅

**A 实现:** `src/shaders/ray-intersection.glsl` line 9-31(`raySphereIntersection` + `rayPlaneIntersection`)
**参考:** `Utils/RayIntersection.glsl` line 4-43

**逐行对比:** A 的 `raySphereIntersection` 和 `rayPlaneIntersection` 与参考**字面一致**(只有 `#define SQR(x)` 被改成 `#define CLEARVIEW_SQR(x)` 避免命名冲突)。

SQR 改名是合理的工程做法,因为 A 把 `SQR` 宏暴露到外部 `#include` 时容易与其他模块冲突。

**判定:** ✅ 算法等价,字面一致(命名空间除外)

**sphere 投影使用:** 在 `clearview-helpers.glsl` 和 `clearview-fragment.glsl` 中,`rayPlaneIntersection` 被用于将 fragment 投影到过 sphere center 且垂直于 viewing direction 的平面上,然后用 `length(projPt - sphereCenter) / sphereRadius` 作为 context opacity 的输入。这与 `ClearView/ClearView.glsl::getClearViewContextFragmentOpacityFactor` 的逻辑**完全一致**。

---

### 3. `getClearViewContextFragmentOpacityFactor` ✅

**A 实现:**
- `src/shaders/clearview-helpers.glsl` line 19-46(完整函数,有 `fragmentPositionWorld` 参数)
- `src/shaders/clearview-fragment.glsl` line 79-99(同样逻辑,内联版本)

**参考:** `ClearView/ClearView.glsl` line 8-32

**算法对比:**

| 步骤 | 参考 | A |
|------|------|---|
| 计算 rayOrigin/rayDirection/fragmentDepth | ✅ | ✅(`fragmentDistance` 提到前面 hoist) |
| `raySphereIntersection` 拿 t0/t1 | ✅ | ✅ |
| 计算 `fragmentInSphere` 标志 | ✅ | ✅ |
| 条件 `(intersectsSphere && (fragmentInSphere \|\| fragmentDepth < t1))` | ✅ | ✅ |
| 用 `rayPlaneIntersection` 投影到过 sphere center 的平面 | ✅ | ✅ |
| `sphereDistance = length(proj - sphereCenter) / sphereRadius` | ✅ | ✅ |
| `opacityFactor = pow(sphereDistance, 4.0)` | ✅ | ✅ |

唯一区别:A 通过 `#define cameraPosition uCameraPosition` 等宏别名,让 `clearview-helpers.glsl` 可以用参考原版的变量名(避免全部重写),这是合理的工程做法。

**判定:** ✅ 算法等价,字面几乎一致

---

### 4. focus factor smoothstep + LOD 插值 ✅

**A 实现:** `src/shaders/clearview-fragment.glsl` line 64-75

**参考:** `ClearView/HexMeshUnified.glsl::Fragment.ClearView_ObjectSpace` 第 162-170 行附近

**逐行对比:** A 的代码块:

```glsl
const float LOD_BLEND_FACTOR_BLEND_START = 0.7;
float focusFactor = 1.0;
if (distanceToFocusPointNormalized >= 1.0) {
    focusFactor = 0.0;
} else if (distanceToFocusPointNormalized > LOD_BLEND_FACTOR_BLEND_START) {
    float t = (distanceToFocusPointNormalized - LOD_BLEND_FACTOR_BLEND_START)
            / (1.0 - LOD_BLEND_FACTOR_BLEND_START);
    focusFactor = 1.0 - t * t * (3.0 - 2.0 * t);
}
```

与参考 `Fragment.ClearView_ObjectSpace` 第 162-170 行**字面一致**(只是参考的 `}` 后多了一个空行,这是排版差异)。

LOD 插值部分(`lodLevelOpacityFactor = mix(ctx, focus, focusFactor)`, `drawLine = lodLevelOpacityFactor > 0.01` 等)在 `clearview-fragment.glsl` line 132-149,与参考第 217-225 行**字面一致**。

**判定:** ✅ 算法等价,字面一致

---

### 5. edge coverage via `smoothstep(1-2EPSILON, 1, x)` ✅(但外围简化)

**A 实现:** `src/shaders/clearview-fragment.glsl` line 178-180

```glsl
float EPSILON = clamp(getAntialiasingFactor(fragmentDistance / lineRadius),
                      0.0, 0.49);
float coverage = 1.0 - smoothstep(1.0 - 2.0 * EPSILON, 1.0, lineCoordinates);
```

**参考:** `ClearView/HexMeshUnified.glsl::Fragment.ClearView_ObjectSpace` 第 270-274 行

```glsl
const float EPSILON = clamp(getAntialiasingFactor(fragmentDistance / lineRadius), 0.0, 0.49);
const float WHITE_THRESHOLD = 0.7 + (0.3 + EPSILON) * contextFactor;
float coverage = 1.0 - smoothstep(1.0 - 2.0*EPSILON, 1.0, lineCoordinates);
vec4 lineColor = vec4(mix(lineBaseColor.rgb, outlineColor,
        smoothstep(WHITE_THRESHOLD - EPSILON, WHITE_THRESHOLD + EPSILON, lineCoordinates)), lineBaseColor.a);
```

**核心 coverage 公式一致** ✅

**⚠️ 但 A 简化了 line color 的视觉细节:**

| 参考有的视觉处理 | A 是否实现 |
|-----------------|-----------|
| `WHITE_THRESHOLD = 0.7 + (0.3 + EPSILON) * contextFactor` | ❌ 未实现 |
| `mix(lineBaseColor, outlineColor, smoothstep(WHITE_THRESHOLD-ε, WHITE_THRESHOLD+ε, x))` 给边线加白色描边 | ❌ 未实现 |
| `lineBaseColor.rgb = mix(lineBaseColor.rgb, vec3(0.5, 0.5, 0.5), depthCueFactor * 0.6)` 灰色化 | ❌ 未实现 |
| `depthCueFactorFocus`/`depthCueFactorDistance` 计算 | ❌ 未实现 |
| `USE_DEPTH_CUES` 控制的黑化 | ❌ 未实现 |
| `if (lineCoordinates >= WHITE_THRESHOLD - EPSILON) fragmentDistance += 0.005` 边线深度偏移 | ❌ 未实现 |
| `else if (lineCoordinatesAll <= 1.0)` 的 ACCENTUATE_ALL_EDGES 二次 pass | ❌ 未实现(`lineCoordinatesAll` 变量在 A 中未计算) |

**视觉影响:** A 渲染出来的边线**没有白色 outline**(参考中边线在 `lineCoordinates >= WHITE_THRESHOLD` 时会从 lineBaseColor 过渡到 `vec3(1.0)` outlineColor,形成"亮线包暗线"的对比);也没有 depth cue 的灰色化混合。

**判定:** ✅ 组件 5 本身(覆盖率公式)等价;⚠️ 但 line rendering 整体被简化(见下面"与参考的偏差汇总")

---

### 6. PPLL 3-pass (clear / gather / resolve) ✅

**A 实现:**
- Clear: `src/shaders/ppll-clear.glsl`(19 行)
- Gather: `src/shaders/ppll-gather.glsl::gatherFragmentCustomDepth`(52 行)
- Resolve: `src/shaders/ppll-resolve.glsl`(88 行)

**参考:**
- `LinkedList/LinkedListClear.glsl`
- `LinkedList/LinkedListGather.glsl`
- `LinkedList/LinkedListResolve.glsl`

**Pipeline 结构对比:**

| 步骤 | 参考 | A |
|------|------|---|
| Clear: `startOffset[i] = -1` (SSBO) | ✅ | ✅(`imageStore(uStartOffsetTex, ivec2(x, y), uvec4(0xFFFFFFFFu, ...))`,image2D 等价) |
| Gather: `atomicCounterIncrement` 拿 insertIndex | ✅ | ✅(line 25) |
| Gather: bounds check | ✅ | ✅(line 27-30) |
| Gather: `atomicExchange` 链头指针 | ✅ | ⚠️ **两步走,有竞争**(见组件 7) |
| Gather: 写入 `fragmentBuffer[insertIndex]` | ✅ | ✅(line 52) |
| Resolve: 沿链表收 numFrags 个节点 | ✅ | ✅(line 41-52) |
| Resolve: 排序 | ✅ | ✅ insertion sort(见组件 8) |
| Resolve: FTB blend | ✅ | ✅(见组件 9) |
| Resolve: 输出到 `fragColor`/`gl_FragColor` | ✅ | ✅(line 86) |

**Pass 1 (clear) 的 viewport 边界检查:** A 增加了 `if (x >= uViewportW || y >= uViewportH) return;`,这是必要的——参考的 `addrGen(uvec2(x,y))` 在 SSBO 中是平坦索引,只要 `x < viewportW && y < viewportH` 就有合法地址;但 A 的 image2D 是 2D 纹理,直接 `imageStore(ivec2(x,y), ...)` 时 `(x,y)` 必须在纹理尺寸内,所以 A 必须显式检查并丢弃越界 fragment。✅ 正确处理。

**Pass 2 (gather) 的 dispatch:** `gl.drawArrays(gl.TRIANGLES, 0, this.faceCount * 6)`——每个 face 6 个顶点(2 个三角形),gl_VertexID 在 `clearview-vertex.glsl` 中被用于 `gl_VertexID / 6 = faceId`,`gl_VertexID % 6 = vertexId`,然后查表得到 4 个 corner vertex 的位置。这与参考的 `(int faceId = globalId / 4; int vertexId = globalId % 4;)` + `gl.drawArrays(GL_QUADS, ...)` **等价**(只是拓扑从 quads 拆成 2 triangles,索引顺序 `(v0, v3, v1) + (v2, v1, v3)` 保证面的朝向一致)。

**Pass 3 (resolve) 的 dispatch:** `gl.drawArrays(gl.TRIANGLES, 0, 3)`——A 用单个 fullscreen 三角形(覆盖 NDC `[-1,3]²`),参考也用类似的全屏 quad。✅ 等价。

**判定:** ✅ 三 pass 架构与参考一致

---

### 7. atomic fragment insertion ⚠️ **存在竞争条件**

**A 实现:** `src/shaders/ppll-gather.glsl` line 16-53

```glsl
void gatherFragmentCustomDepth(vec4 color, float depth) {
    if (color.a < 1e-4) {
        return;
    }

    int x = int(gl_FragCoord.x);
    int y = int(gl_FragCoord.y);
    uint pixelIndex = addrGen(ivec2(x, y));          // ← 计算了但没用到(image2D 直接 ivec2)

    uint insertIndex = atomicCounterIncrement(uFragCounter);

    if (insertIndex >= uLinkedListSize) {
        return;
    }

    // Read current head of the linked list for this pixel.
    uint oldHead = imageLoad(uStartOffsetTex, ivec2(x, y)).r;   // ← ①

    uvec4 frag;
    frag.r = packColor(color);
    frag.g = floatBitsToUint(depth);
    frag.b = oldHead;                                  // ← 用 ① 的值作为 next
    frag.a = 0u;

    imageAtomicExchange(uStartOffsetTex, ivec2(x, y), insertIndex);   // ← ② 丢弃返回值!
    imageStore(uFragmentBufferTex, ivec2(int(insertIndex), 0), frag);
}
```

**参考:** `LinkedList/LinkedListGather.glsl` line 30-50

```glsl
void gatherFragmentCustomDepth(vec4 color, float depth) {
    if (color.a < 1e-4) {
        return;
    }

    int x = int(gl_FragCoord.x);
    int y = int(gl_FragCoord.y);
    uint pixelIndex = addrGen(uvec2(x,y));

    LinkedListFragmentNode frag;
    frag.color = packUnorm4x8(color);
    frag.depth = depth;
    frag.next = -1;                       // 先填 -1

    uint insertIndex = atomicCounterIncrement(fragCounter);

    if (insertIndex < linkedListSize) {
        // 关键一步: atomicExchange 同时完成「读旧值」+「写入新值」,且返回值就是「读到的旧值」
        frag.next = atomicExchange(startOffset[pixelIndex], insertIndex);
        fragmentBuffer[insertIndex] = frag;
    }
}
```

**问题:**

参考用的是 GLSL 内建 `atomicExchange(memory, value)`——这个函数是**原子的**:
- 读取 `memory` 处的旧值
- 把 `value` 写入 `memory`
- 把读到的旧值**作为返回值**返回

所以 `frag.next = atomicExchange(startOffset[pixelIndex], insertIndex)` 一次性原子地完成"记录旧链头 + 把新节点挂到链头",**不会丢节点**。

A 的做法拆成了两步:
1. `uint oldHead = imageLoad(...);`  ← 非原子的读
2. `imageAtomicExchange(..., insertIndex);` ← 原子的"读旧值并写入新值",**但 A 丢弃了返回值**,然后把第 1 步读到的 `oldHead` 作为 next

**竞争场景**(同一像素上两个 fragment 并发插入):

| 时刻 | Fragment A | Fragment B | head 当前值 |
|------|-----------|-----------|-----------|
| t=0 | imageLoad → oldHead_A = END | | END |
| t=1 | | imageLoad → oldHead_B = END | END |
| t=2 | atomicCounterIncrement → idx_A = 0 | | END |
| t=3 | | atomicCounterIncrement → idx_B = 1 | END |
| t=4 | frag_A.next = END (用 oldHead_A) | | END |
| t=5 | imageAtomicExchange → head = 0 | | 0 |
| t=6 | | frag_B.next = END (用 oldHead_B,A 也读到了 END)| |
| t=7 | | imageAtomicExchange → head = 1 | 1 |
| t=8 | imageStore(0, frag_A) | | 1 |
| t=9 | | imageStore(1, frag_B) | 1 |

在这个**理想化交错**里,A 和 B 都读到 END(因为都在对方插入之前 imageLoad),所以链是 `head=1 → slot1.next=END`,但 slot0 也是 next=END,**两个 fragment 都成了孤岛**!

正确版本应该是:

```glsl
frag.b = imageAtomicExchange(uStartOffsetTex, ivec2(x, y), insertIndex);
```

这样:
- `imageAtomicExchange` 在同一原子事务里:读 head(=1,即对方刚写的)+ 写 head(insertIndex=2),返回 1
- frag_B.next = 1,指向 A 的节点
- 链: `head=2 → slot2.next=1 → slot1.next=END` ✅

**实际触发概率:**
- SPE-9 深度复杂度 10-30(参考 `verification.md` §6 自报)
- 每个 fragment 落在同一像素的概率取决于视角,在 focus 区域的边线像素尤其集中
- 如果 GPU 的 warp/threadgroup 是顺序执行 imageLoad/atomicExchange,某些驱动可能会避免竞争
- WebGL2 规范对 image atomic 的内存序要求比较松(`coherent` qualifier 默认不要求 acquire/release),**没有保证 imageLoad 读到 imageAtomicExchange 写入的最新值**

**视觉影响:** resolve pass 只能看到链表头部能追到的片段,孤儿节点(链表断在 END 的非头部节点)永远不会被 blend 出来。在 focus + context 边缘附近,边线像素的深度复杂度可达几十,竞争条件会**显著丢片段**,表现为 focus 区域的边线"破洞"或闪烁。

**修复(2 行改动):**

```glsl
// 修复前:
uint oldHead = imageLoad(uStartOffsetTex, ivec2(x, y)).r;
// ... frag.b = oldHead; ...
imageAtomicExchange(uStartOffsetTex, ivec2(x, y), insertIndex);

// 修复后:
frag.b = imageAtomicExchange(uStartOffsetTex, ivec2(x, y), insertIndex);
```

**判定:** ⚠️ **算法不正确**——读旧值和交换 head 不在同一原子事务内,导致链表断链。修复极其简单,必须改。

---

### 8. depth sort (insertion) ✅

**A 实现:** `src/shaders/ppll-resolve.glsl` line 58-72

```glsl
for (uint i = 1u; i < uint(numFrags); ++i) {
    uint fragColor = colorList[i];
    float fragDepth = depthList[i];

    uint j = i;
    while (j >= 1u && depthList[j - 1u] > fragDepth) {
        colorList[j] = colorList[j - 1u];
        depthList[j] = depthList[j - 1u];
        --j;
    }
    colorList[j] = fragColor;
    depthList[j] = fragDepth;
}
```

**参考:** `LinkedList/LinkedListSort.glsl::insertionSort` line 95-119

**逐行对比:** A 与参考**算法字面一致**。参考用 `DEPTH_TYPE` 模板(`float` 或 `uint`),A 硬编码 `float`(因为没用 `DEPTH_TYPE_UINT` 路径)。插入排序的比较符号 `>`、`>=`、循环边界与参考完全相同。

**判定:** ✅ 算法等价

---

### 9. FTB blending ✅(任务描述里写的"back-to-front"是笔误)

**A 实现:** `src/shaders/ppll-resolve.glsl` line 74-84

```glsl
vec4 outColor = vec4(0.0);
for (int i = 0; i < MAX_NUM_FRAGS; i++) {
    if (i >= numFrags) break;
    vec4 src = unpackColor(colorList[i]);
    outColor.rgb = outColor.rgb + (1.0 - outColor.a) * src.a * src.rgb;
    outColor.a   = outColor.a + (1.0 - outColor.a) * src.a;
    if (outColor.a > 0.995) break;
}

if (outColor.a > 1e-4) {
    outColor.rgb /= outColor.a;
}
```

**参考:** `LinkedList/LinkedListSort.glsl::blendFTB` line 32-43

```glsl
vec4 blendFTB(uint fragsCount) {
    vec4 color = vec4(0.0);
    for (uint i = 0; i < fragsCount; i++) {
        vec4 colorSrc = unpackUnorm4x8(colorList[i]);
        color.rgb = color.rgb + (1.0 - color.a) * colorSrc.a * colorSrc.rgb;
        color.a = color.a + (1.0 - color.a) * colorSrc.a;
    }
    return vec4(color.rgb / color.a, color.a);
}
```

**逐行对比:** A 的公式与参考 `blendFTB` **字面一致**:
- 累加公式 `outColor.rgb += (1 - outColor.a) * src.a * src.rgb` ✅
- alpha 累加 `outColor.a += (1 - outColor.a) * src.a` ✅
- 末尾归一化 `outColor.rgb /= outColor.a`(在 `outColor.a > 1e-4` 时)✅

A 加了 2 个安全优化:
- `if (outColor.a > 0.995) break;` —— 提前退出,跳过完全不透明的累加
- `if (i >= numFrags) break;` —— numFrags < MAX_NUM_FRAGS 时跳过末尾空槽

这两个优化对正确性**无影响**。

**注意:** 任务描述里说的是"back-to-front alpha blending",但参考 `LinkedListSort.glsl` 的函数名叫 **`blendFTB`**(Front-To-Back),把最近片段先画在远片段之前。`blendFTB` 与 `outColor.a` 累加搭配,是经典的 FTB blending。A 实现的是 FTB(insertion sort 后 depthList 是 ascending,即从近到远,然后 `blendFTB` 从 i=0 开始累加最近片段),**与参考完全一致**。任务描述里的 "back-to-front" 是措辞错误,实际应该是 "front-to-back",**A 的实现是对的**。

**判定:** ✅ 算法等价,字面几乎一致(函数名都是 FTB)

---

## 与参考的偏差汇总

| # | 偏差 | 影响 | 是否可接受 |
|---|------|------|-----------|
| 1 | SSBO → image2D(`uStartOffsetTex`/`uFragmentBufferTex`) | WebGL2 无 SSBO 支持,这是必须的适配 | ✅ 必须 |
| 2 | `layout(std430, binding=N) coherent buffer` → `layout(r32ui) uniform highp uimage2D` | 配合 `gl.bindImageTexture()` | ✅ 必须 |
| 3 | `atomic_uint` 用 `layout(binding=N, offset=0) uniform atomic_uint` | WebGL2 支持,完全等价 | ✅ |
| 4 | `atomicExchange(startOffset[i], val)` → `imageLoad + imageAtomicExchange` 拆两步 | **链表断链 bug** | ❌ **必须改** |
| 5 | Half-Edge 数据结构 → per-cell enumeration(54000 faces vs ~28000 unique) | 多绘制一次(双倍几何),但算法逻辑不变 | ✅ PLAN §ST-1 已记录 |
| 6 | LOD 真值(`generateSheetLevelOfDetailEdgeStructure()`)→ 标量代理 `edgeLod = 1 - normScalar` | LOD 切换不那么精准(所有同 scalar 等级的边行为一致) | ⚠️ PLAN §ST-1 简化,首版可接受 |
| 7 | Reference 的 `Fragment.ClearView_ScreenSpace` 变体未实现 | 只用 object-space focus sphere | ✅ PLAN §ST-9 决定 |
| 8 | `Mouse picking` 用 screen-space delta,不用 ray-mesh intersection | sphere 不能 snap 到 cell center | ⚠️ PLAN §ST-9 简化 |
| 9 | Line rendering 简化:无 WHITE_THRESHOLD 描边、无 depth cue 灰化、无 ACCENTUATE_ALL_EDGES | focus 区域边线没有"白线包暗线"对比,depth cue 较弱 | ⚠️ **视觉有差异但功能可达** |
| 10 | Reference 的 `DepthCues.glsl`、`FocusOutlineShader.glsl` 未引入 | depth cue 黑化、focus outline 装饰未实现 | ⚠️ 装饰性,不影响 focus+context 核心功能 |
| 11 | Reference 的 `LinkedListQuicksort.glsl` 未引入 | 只用 insertion sort | ✅ MAX_NUM_FRAGS=32 时 insertion sort 更快 |
| 12 | Fragment color packing 从 `packUnorm4x8` 改为自定义 `packColor` 10×4 bits | 精度从 8bit/通道 提升到 10bit/通道 | ✅ **A 实际更精确** |
| 13 | Depth packing 用 `floatBitsToUint(depth)`,不用 `packFloat22Float10` | 32-bit 浮点深度,精度更高 | ✅ **A 实际更精确** |

**必须修复的项:** 4(链表断链 bug)
**建议修复的项:** 9(视觉简化)
**可接受但建议记录的项:** 6、8

---

## 视觉验证

没有跑 headless 截图(verifier 角色只读不改,不执行渲染代码)。仅基于 shader 代码静态分析推断的视觉差异:

| 区域 | 参考应有的效果 | A 的实际效果 |
|------|---------------|-------------|
| Focus 区域内的边线 | 暗线被亮色描边包裹,有 depth cue 灰化 | 只有暗线,无描边 |
| Focus 球边界 | sphere 边界有 outline(FocusOutlineShader),紫红色边 | 无 outline 渲染 |
| Context 区域 | volume 透明度按 `pow(d, 4)` 渐变 + 灰化 | 只有 `pow(d, 4)` 透明度,无灰化 |
| 边线深度偏移 | `lineCoordinates >= WHITE_THRESHOLD - EPSILON` 时 `fragmentDistance += 0.005`,让边线显示在 volume 前 | 无此偏移,边线可能与 volume 同深度 |
| 距离远的边线 | ACCENTUATE_ALL_EDGES pass 显示边线 | 不显示 |

**估计:** 在 Apple Silicon GPU 上,如果跑 SPE-9 数据集,**视觉差异主要在边线的"质感"上**(没有 outline 描边会显得"扁平"),而 focus+context 核心的 opacity 渐变和 LOD 切换应该都能正确工作。**视觉上"能跑通"但"和原版不太像"。**

由于组件 7 的 bug,深度复杂度高的像素上可能看到**边线残缺**(resolve pass 只画到链表头部能追到的节点)。

---

## 建议改进

1. **【高优先】修复 PPLL gather 的竞争条件**
   - 文件:`src/shaders/ppll-gather.glsl`
   - 把 `uint oldHead = imageLoad(...); ... imageAtomicExchange(...);` 改成 `frag.b = imageAtomicExchange(...);`
   - 2 行改动,可显著改善 focus 区域边线的完整性

2. **【中优先】补全 line rendering 的视觉细节**
   - 至少实现 `WHITE_THRESHOLD` 描边(白线包暗线)
   - 可选:`lineBaseColor` 与 `vec3(0.5)` 灰化的 depth cue mix
   - 修复后边线视觉与参考更接近

3. **【低优先】补全 `Fragment.ClearView_ScreenSpace` 变体**
   - 如果后续要让 focus sphere 可"贴合屏幕",这个变体更直观
   - PLAN §ST-9 已标为 out of scope,可后续补

4. **【低优先】升级 LOD 算法**
   - 目前用 scalar-based proxy,如果后续需要真 sheet-collapse LOD,需要补 `generateSheetLevelOfDetailEdgeStructure()`
   - PLAN §Out of scope

5. **【低优先】补 `Mouse picking` 的 ray-mesh intersection**
   - 目前 screen-space delta 拖拽
   - 真 ray-mesh intersection 能 snap 到 cell center

---

## 附录:审查过程记录

1. ✅ `node --check src/buffer-data.js src/textures.js src/clearview.js src/shader-loader.js` 全部通过
2. ❌ `glslangValidator` 在本机未安装(`/opt/homebrew/bin/glsl*` 不存在),无法静态验证 GLSL 语法
3. ✅ 行级 diff:每个 shader 文件逐一对照参考实现
4. ✅ 关键调用链:`gatherFragmentCustomDepth` → `atomicCounterIncrement` → `imageLoad`/`imageAtomicExchange` → `imageStore`
5. ✅ resolve 排序+blend 循环与 `LinkedListSort.glsl::insertionSort + blendFTB` 对照

**审查覆盖范围:**
- 9 个 GLSL 组件(对应任务表的 9 项)
- 1 个 JS 入口(`clearview.js::render`,验证 3-pass dispatch)
- 4 个 JS 模块(`buffer-data.js`、`textures.js`、`clearview.js`、`shader-loader.js` 语法检查)

**审查未覆盖:**
- 没跑 headless 截图
- 没验证 GLSL 实际编译(没有 `glslangValidator`)
- 没跑实际的 PPLL 链路(节点无法启动 GPU 上下文)

---

## 结论

**A 的实现整体忠实还原了原版的算法思路**(尤其是 PPLL 的 3-pass 架构、insertion sort、FTB blending、focus/context opacity 计算这些核心部分),**SSBO → image2D 的适配是必要且正确的**。

**主要问题:** 第 7 项的链表插入有竞争 bug(`imageLoad + imageAtomicExchange` 拆两步,非原子),**会导致深度复杂度高的像素上链表断链、resolve 时丢片段**。修复成本极低(2 行),**必须修复**。

**次要问题:** line rendering 视觉细节被简化(无 outline 描边、无 depth cue 灰化、无 ACCENTUATE_ALL_EDGES),**视觉与原版有差距但不影响 focus+context 核心功能**,可后续迭代补全。

**任务表第 9 项的措辞 "back-to-front" 是错误的**——参考实现 `LinkedListSort.glsl::blendFTB` 实际是 Front-To-Back,A 的实现正确匹配了参考的 FTB。