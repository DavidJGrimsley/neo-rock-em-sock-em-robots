package expo.modules.questpanel

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.RectF
import android.graphics.Typeface
import android.text.TextPaint
import android.text.TextUtils
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.util.concurrent.Executors

private const val TAG = "QuestPanel"

// QuestPanelLayer.h in tools/quest/viro-renderer/0002-openxr-quest-panel-layer.patch.
private const val NATIVE_VERSION = 1

// Draws the clean headset compositor UI with Android Canvas and hands the pixels
// and pose to the patched Viro renderer, which submits them as an OpenXR quad
// layer under the scene. Adapted from the Medical Viewer QuestPanelModule
// (owner token, one worker that coalesces to the newest spec). Nothing here
// touches Viro materials or the XR session.
class QuestPanelModule : Module() {
  @Volatile private var owner = 0
  @Volatile private var drawFailed = false
  private val drawLock = Any()
  private val queueLock = Any()
  private val drawExecutor = Executors.newSingleThreadExecutor()
  private var pendingDraw: Pair<Int, String>? = null
  private var drawRunning = false

  // Guarded by drawLock.
  private var panelBitmap: Bitmap? = null
  private var panelPixels: ByteBuffer? = null
  // The pixels the renderer holds; a spec with the same pixels only moves them.
  private var drawnPixelsKey: String? = null

  private external fun nativeVersion(): Int
  private external fun nativeStatus(): Int
  private external fun nativeHide()
  private external fun nativePose(pose: FloatArray): Boolean
  private external fun nativeDraw(
    rgba: ByteArray,
    width: Int,
    height: Int,
    widthM: Float,
    heightM: Float,
    pose: FloatArray
  ): Boolean

  // Phone builds and the stock renderer have no QuestPanelLayer symbols.
  private val available: Boolean by lazy {
    try {
      System.loadLibrary("viro_renderer")
      nativeVersion() == NATIVE_VERSION
    } catch (_: LinkageError) {
      false
    }
  }

  private fun releaseRaster() {
    panelBitmap?.recycle()
    panelBitmap = null
    panelPixels = null
    drawnPixelsKey = null
  }

  private fun rect(op: JSONObject) = RectF(
    op.getDouble("x").toFloat(),
    op.getDouble("y").toFloat(),
    (op.getDouble("x") + op.getDouble("width")).toFloat(),
    (op.getDouble("y") + op.getDouble("height")).toFloat()
  )

  private fun drawOps(canvas: Canvas, ops: JSONArray, width: Int) {
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    for (index in 0 until ops.length()) {
      val op = ops.getJSONObject(index)
      when (op.getString("op")) {
        "roundRect" -> {
          paint.style = Paint.Style.FILL
          paint.color = Color.parseColor(op.getString("color"))
          val radius = op.optDouble("radius", 0.0).toFloat()
          canvas.drawRoundRect(rect(op), radius, radius, paint)
        }
        "text" -> {
          val text = op.optString("text")
          if (text.isEmpty()) continue
          val glyph = TextPaint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG)
          glyph.color = Color.parseColor(op.optString("color", "#f8fafc"))
          glyph.textSize = op.optDouble("size", 32.0).toFloat()
          glyph.typeface = if (op.optBoolean("bold")) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
          glyph.textAlign =
            if (op.optString("align") == "center") Paint.Align.CENTER else Paint.Align.LEFT
          val maxWidth = op.optDouble("maxWidth", width.toDouble()).toFloat()
          val shown = TextUtils.ellipsize(
            text,
            glyph,
            maxWidth.coerceAtLeast(0f),
            TextUtils.TruncateAt.END
          ).toString()
          // y is the top of the em box. Canvas draws from the baseline.
          canvas.drawText(
            shown,
            op.getDouble("x").toFloat(),
            op.getDouble("y").toFloat() - glyph.ascent(),
            glyph
          )
        }
        else -> error("Unknown menu draw operation.")
      }
    }
  }

  private fun poseOf(spec: JSONObject): FloatArray {
    val values = spec.getJSONArray("pose")
    require(values.length() == 7) { "Menu panel pose needs 7 numbers." }
    return FloatArray(7) { index ->
      values.getDouble(index).toFloat().also { require(it.isFinite()) { "Menu panel pose is not finite." } }
    }
  }

  private fun renderPanel(id: Int, json: String) {
    synchronized(drawLock) { renderOwned(id, json) }
  }

  // Runs on the draw worker with drawLock held.
  private fun renderOwned(id: Int, json: String) {
    if (id != owner) return
    check(available) { "Quest compositor renderer is not installed." }
    val started = System.nanoTime()
    val spec = JSONObject(json)
    val label = spec.optString("label", "menu")
    val width = spec.getInt("widthPx")
    val height = spec.getInt("heightPx")
    val widthM = spec.getDouble("widthM").toFloat()
    val heightM = spec.getDouble("heightM").toFloat()
    require(width in 1..4096 && height in 1..4096) { "Menu panel size is out of range." }
    require(widthM.isFinite() && widthM > 0f && widthM <= 2f) { "Menu panel width is out of range." }
    require(heightM.isFinite() && heightM > 0f && heightM <= 2f) { "Menu panel height is out of range." }
    val pose = poseOf(spec)
    val ops = spec.getJSONArray("ops")
    require(ops.length() in 1..160) { "Menu panel has no drawing operations." }
    val pixelsKey = "$width:$height:$widthM:$heightM:$ops"
    if (pixelsKey == drawnPixelsKey) {
      check(nativePose(pose)) { "The renderer rejected the menu pose." }
      Log.i(TAG, "moved $label")
      return
    }
    if (panelBitmap?.width != width || panelBitmap?.height != height) {
      releaseRaster()
      panelBitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
      panelPixels = ByteBuffer.allocate(panelBitmap!!.byteCount)
    }
    val bitmap = panelBitmap!!
    val pixels = panelPixels!!
    val canvas = Canvas(bitmap)
    canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
    drawOps(canvas, ops, width)
    val drawn = System.nanoTime()
    pixels.rewind()
    bitmap.copyPixelsToBuffer(pixels)
    check(nativeDraw(pixels.array(), width, height, widthM, heightM, pose)) {
      "The renderer rejected the menu panel."
    }
    drawnPixelsKey = pixelsKey
    val end = System.nanoTime()
    Log.i(
      TAG,
      "drawn $label ${width}x$height ops=${ops.length()} " +
        "canvas=${(drawn - started) / 1_000_000}ms total=${(end - started) / 1_000_000}ms"
    )
  }

  private fun enqueueDraw(id: Int, json: String) {
    synchronized(queueLock) {
      pendingDraw = id to json
      if (drawRunning) return
      drawRunning = true
    }
    drawExecutor.execute {
      while (true) {
        val next = synchronized(queueLock) {
          val value = pendingDraw
          pendingDraw = null
          if (value == null) drawRunning = false
          value
        } ?: break
        try {
          renderPanel(next.first, next.second)
        } catch (error: Throwable) {
          if (next.first == owner) drawFailed = true
          Log.e(TAG, "Menu panel draw failed", error)
          synchronized(queueLock) {
            pendingDraw = null
            drawRunning = false
          }
          break
        }
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("QuestPanel")

    Function("isAvailable") { available }

    // A new owner starts hidden, so a stale panel from an earlier scene never shows.
    Function("open") {
      synchronized(drawLock) {
        check(available) { "Quest compositor renderer is not installed." }
        nativeHide()
        drawFailed = false
        drawnPixelsKey = null
        ++owner
      }
    }

    // 1 submitted, 0 not yet drawn or hidden, -1 failed or not the current owner.
    Function("status") { id: Int -> if (id == owner && !drawFailed) nativeStatus() else -1 }

    Function("draw") { id: Int, json: String -> if (id == owner) enqueueDraw(id, json) }

    Function("hide") { id: Int ->
      synchronized(drawLock) {
        if (id == owner) {
          ++owner
          if (available) nativeHide()
          releaseRaster()
        }
      }
    }

    OnDestroy {
      synchronized(drawLock) {
        ++owner
        if (available) nativeHide()
        releaseRaster()
      }
      drawExecutor.shutdown()
    }
  }
}
