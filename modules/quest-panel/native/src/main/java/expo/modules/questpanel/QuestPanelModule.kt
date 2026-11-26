package expo.modules.questpanel

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.RectF
import android.graphics.Typeface
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.text.TextPaint
import android.text.TextUtils
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.concurrent.Executors

private const val TAG = "QuestPanel"

// QuestPanelLayer.h, including VIEW space support from renderer patch 0008.
private const val NATIVE_VERSION = 4

// Draws the compact headset compositor button card (underlay) and the floating
// transparent branded title (overlay) with Android Canvas, handing pixels and
// poses to the patched Viro renderer. Nothing here touches Viro materials or
// the XR session.
class QuestPanelModule : Module() {
  private val drawExecutor = Executors.newSingleThreadExecutor()
  private val assetLock = Any()
  private val typefaces = HashMap<String, Typeface>()
  private val warnedFonts = HashSet<String>()
  private val bitmaps = HashMap<String, Bitmap>()
  private val warnedImages = HashSet<String>()
  private val colorCache = HashMap<String, Int>()
  private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val imagePaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val glyphPaint = TextPaint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG)

  private external fun nativeVersion(): Int
  private external fun nativeRefSpaceEpoch(): Int
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

  private external fun nativeTitleStatus(): Int
  private external fun nativeTitleHide()
  private external fun nativeTitlePoseInSpace(pose: FloatArray, viewLocked: Boolean): Boolean
  private external fun nativeTitleDrawInSpace(
    rgba: ByteArray,
    width: Int,
    height: Int,
    widthM: Float,
    heightM: Float,
    pose: FloatArray,
    viewLocked: Boolean
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

  private inner class PanelSlot(
    private val slotName: String,
    private val nativeStatusFn: () -> Int,
    private val nativeHideFn: () -> Unit,
    private val nativePoseFn: (FloatArray, Boolean) -> Boolean,
    private val nativeDrawFn: (ByteArray, Int, Int, Float, Float, FloatArray, Boolean) -> Boolean
  ) {
    @Volatile var owner = 0
    @Volatile var drawFailed = false
    private val drawLock = Any()
    private val queueLock = Any()
    private var pendingDraw: Pair<Int, String>? = null
    private var drawRunning = false

    private var panelBitmap: Bitmap? = null
    private var panelPixels: ByteArray? = null
    private var drawnPixelsKey: String? = null

    private fun releaseRaster() {
      panelBitmap?.recycle()
      panelBitmap = null
      panelPixels = null
      drawnPixelsKey = null
    }

    fun open(): Int = synchronized(drawLock) {
      check(available) { "Quest compositor renderer is not installed." }
      nativeHideFn()
      drawFailed = false
      drawnPixelsKey = null
      ++owner
    }

    fun status(id: Int): Int = if (id == owner && !drawFailed) nativeStatusFn() else -1

    fun invalidate(id: Int) {
      synchronized(drawLock) {
        if (id == owner) {
          drawnPixelsKey = null
        }
      }
    }

    fun hide(id: Int) {
      synchronized(drawLock) {
        if (id == owner) {
          ++owner
          if (available) nativeHideFn()
          releaseRaster()
        }
      }
    }

    fun destroy() {
      synchronized(drawLock) {
        ++owner
        if (available) nativeHideFn()
        releaseRaster()
      }
    }

    fun enqueueDraw(id: Int, json: String) {
      if (id != owner) return
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
            synchronized(drawLock) { renderOwned(next.first, next.second) }
          } catch (error: Throwable) {
            if (next.first == owner) drawFailed = true
            Log.e(TAG, "$slotName draw failed", error)
            synchronized(queueLock) {
              pendingDraw = null
              drawRunning = false
            }
            break
          }
        }
      }
    }

    private fun renderOwned(id: Int, json: String) {
      if (id != owner) return
      check(available) { "Quest compositor renderer is not installed." }
      val started = System.nanoTime()
      val spec = JSONObject(json)
      val label = spec.optString("label", slotName)
      val width = spec.getInt("widthPx")
      val height = spec.getInt("heightPx")
      val widthM = spec.getDouble("widthM").toFloat()
      val heightM = spec.getDouble("heightM").toFloat()
      require(width in 1..4096 && height in 1..4096) { "Menu panel size is out of range." }
      require(widthM.isFinite() && widthM > 0f && widthM <= 2f) { "Menu panel width is out of range." }
      require(heightM.isFinite() && heightM > 0f && heightM <= 2f) { "Menu panel height is out of range." }
      val pose = poseOf(spec)
      val viewLocked = spec.optBoolean("viewLocked", false)
      val ops = spec.getJSONArray("ops")
      require(ops.length() in 1..160) { "Menu panel has no drawing operations." }
      val pixelsKey = "$width:$height:$widthM:$heightM:$ops"
      if (pixelsKey == drawnPixelsKey) {
        check(nativePoseFn(pose, viewLocked)) { "The renderer rejected the $slotName pose." }
        Log.i(TAG, "moved $slotName $label viewLocked=$viewLocked")
        return
      }
      if (panelBitmap?.width != width || panelBitmap?.height != height) {
        releaseRaster()
        panelBitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        panelPixels = ByteArray(panelBitmap!!.byteCount)
      }
      val bitmap = panelBitmap!!
      val pixels = panelPixels!!
      val canvas = Canvas(bitmap)
      canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
      drawOps(canvas, ops, width)
      val drawn = System.nanoTime()
      val buffer = ByteBuffer.wrap(pixels)
      buffer.rewind()
      bitmap.copyPixelsToBuffer(buffer)
      check(nativeDrawFn(pixels, width, height, widthM, heightM, pose, viewLocked)) {
        "The renderer rejected the $slotName panel."
      }
      drawnPixelsKey = pixelsKey
      val end = System.nanoTime()
      Log.i(
        TAG,
        "drawn $slotName $label ${width}x$height ops=${ops.length()} " +
          "canvas=${(drawn - started) / 1_000_000}ms total=${(end - started) / 1_000_000}ms"
      )
    }
  }

  private val menuSlot = PanelSlot(
    slotName = "menu",
    nativeStatusFn = { nativeStatus() },
    nativeHideFn = { nativeHide() },
    nativePoseFn = { pose, _ -> nativePose(pose) },
    nativeDrawFn = { rgba, w, h, wm, hm, pose, _ -> nativeDraw(rgba, w, h, wm, hm, pose) }
  )

  private val titleSlot = PanelSlot(
    slotName = "title",
    nativeStatusFn = { nativeTitleStatus() },
    nativeHideFn = { nativeTitleHide() },
    nativePoseFn = ::nativeTitlePoseInSpace,
    nativeDrawFn = { rgba, w, h, wm, hm, pose, viewLocked ->
      nativeTitleDrawInSpace(rgba, w, h, wm, hm, pose, viewLocked)
    }
  )

  private fun releaseAssets() {
    synchronized(assetLock) {
      for (bitmap in bitmaps.values) {
        if (!bitmap.isRecycled) bitmap.recycle()
      }
      bitmaps.clear()
      typefaces.clear()
      colorCache.clear()
    }
  }

  private fun colorOf(hex: String): Int {
    synchronized(assetLock) {
      return colorCache.getOrPut(hex) { Color.parseColor(hex) }
    }
  }

  private fun existingFile(value: String): File? {
    if (value.startsWith("file:///android_res/")) return null
    val path = when {
      value.startsWith("file:") -> Uri.parse(value).path
      value.startsWith("/") -> value
      else -> null
    } ?: return null
    if (path.startsWith("/android_res/")) return null
    val file = File(path)
    return if (file.isFile && file.length() > 0L) file else null
  }

  @SuppressLint("DiscouragedApi")
  private fun openPackaged(context: Context, value: String): InputStream? {
    if (value.startsWith("file:///android_res/")) {
      val segments = Uri.parse(value).pathSegments
      if (segments.size < 3) return null
      val directory = segments[1].substringBefore('-')
      val name = segments[2].substringBeforeLast('.', segments[2])
      val id = context.resources.getIdentifier(name, directory, context.packageName)
      return if (id != 0) context.resources.openRawResource(id) else null
    }
    if (value.contains(":")) return null
    val id = context.resources.getIdentifier(value, "raw", context.packageName).takeIf { it != 0 }
      ?: context.resources.getIdentifier(value, "drawable", context.packageName).takeIf { it != 0 }
      ?: return null
    return context.resources.openRawResource(id)
  }

  private fun sourceCacheName(value: String, extension: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
    val hex = digest.joinToString("") { byte -> "%02x".format(byte) }.take(20)
    val suffix = extension.lowercase().filter { it.isLetterOrDigit() }.ifEmpty { "bin" }
    return "src-$hex.$suffix"
  }

  // Release fonts and title PNGs are Android resources, not filesystem paths.
  // Copy those bytes to cache once on the draw worker so native decoders work
  // off the main thread without delaying the first frame.
  private fun materialize(value: String, extension: String): File {
    existingFile(value)?.let { return it }
    val context = appContext.reactContext ?: error("Quest panel has no Android context.")
    val input = openPackaged(context, value) ?: error("Quest panel asset is not a file: $value")
    val directory = File(context.cacheDir, "quest-panel-src")
    if (!directory.isDirectory && !directory.mkdirs()) {
      error("Quest panel cache directory was not created.")
    }
    val file = File(directory, sourceCacheName(value, extension))
    if (file.isFile && file.length() > 0L) {
      input.close()
      return file
    }
    val temp = File(directory, "${file.name}.tmp")
    try {
      input.use { stream ->
        FileOutputStream(temp).use { out ->
          val copied = stream.copyTo(out)
          if (copied <= 0L) error("Quest panel asset was empty: $value")
        }
      }
      if (!temp.renameTo(file) && !file.isFile) {
        error("Quest panel asset cache rename failed: $value")
      }
    } catch (failure: Exception) {
      temp.delete()
      throw failure
    }
    return file
  }

  private fun resolveBitmap(uri: String): Bitmap? {
    if (uri.isEmpty()) return null
    synchronized(assetLock) {
      bitmaps[uri]?.let { if (!it.isRecycled) return it }
    }
    return try {
      val file = materialize(uri, "png")
      val options = BitmapFactory.Options().apply { inScaled = false }
      val decoded = BitmapFactory.decodeFile(file.absolutePath, options)
        ?: error("Quest panel image could not be decoded: $uri")
      synchronized(assetLock) { bitmaps[uri] = decoded }
      decoded
    } catch (error: Throwable) {
      if (synchronized(assetLock) { warnedImages.add(uri) }) {
        Log.w(TAG, "Falling back to text title for $uri", error)
      }
      null
    }
  }

  private fun resolveTypeface(font: String, bold: Boolean): Typeface {
    if (font.isEmpty()) return if (bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
    synchronized(assetLock) { typefaces[font]?.let { return it } }
    return try {
      val file = materialize(font, "ttf")
      val face = synchronized(assetLock) {
        typefaces[file.absolutePath] ?: Typeface.createFromFile(file).also {
          typefaces[file.absolutePath] = it
        }
      }
      synchronized(assetLock) { typefaces[font] = face }
      face
    } catch (error: Throwable) {
      if (synchronized(assetLock) { warnedFonts.add(font) }) {
        Log.w(TAG, "Falling back to system typeface for $font", error)
      }
      if (bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
    }
  }

  private fun rect(op: JSONObject) = RectF(
    op.getDouble("x").toFloat(),
    op.getDouble("y").toFloat(),
    (op.getDouble("x") + op.getDouble("width")).toFloat(),
    (op.getDouble("y") + op.getDouble("height")).toFloat()
  )

  private fun drawTextOp(
    canvas: Canvas,
    text: String,
    x: Float,
    y: Float,
    size: Float,
    color: String,
    align: String,
    bold: Boolean,
    font: String,
    maxWidth: Float
  ) {
    if (text.isEmpty()) return
    synchronized(glyphPaint) {
      glyphPaint.color = colorOf(color)
      glyphPaint.textSize = size
      glyphPaint.typeface = resolveTypeface(font, bold)
      glyphPaint.textAlign = if (align == "center") Paint.Align.CENTER else Paint.Align.LEFT
      val shown = TextUtils.ellipsize(
        text,
        glyphPaint,
        maxWidth.coerceAtLeast(0f),
        TextUtils.TruncateAt.END
      ).toString()
      // y is the top of the em box. Canvas draws from the baseline.
      canvas.drawText(shown, x, y - glyphPaint.ascent(), glyphPaint)
    }
  }

  private fun drawOps(canvas: Canvas, ops: JSONArray, width: Int) {
    synchronized(fillPaint) {
      for (index in 0 until ops.length()) {
        val op = ops.getJSONObject(index)
        when (op.getString("op")) {
          "roundRect" -> {
            fillPaint.color = colorOf(op.getString("color"))
            val radius = op.optDouble("radius", 0.0).toFloat()
            canvas.drawRoundRect(rect(op), radius, radius, fillPaint)
          }
          "image" -> {
            val bitmap = resolveBitmap(op.optString("uri"))
            if (bitmap != null) {
              canvas.drawBitmap(bitmap, null, rect(op), imagePaint)
            } else {
              val fallback = op.optString("text")
              if (fallback.isNotEmpty()) {
                val boxW = op.getDouble("width").toFloat()
                val boxH = op.getDouble("height").toFloat()
                val size = op.optDouble("size", (boxH * 0.6).coerceAtLeast(32.0)).toFloat()
                drawTextOp(
                  canvas,
                  text = fallback,
                  x = (op.getDouble("x") + boxW / 2.0).toFloat(),
                  y = (op.getDouble("y") + ((boxH - size) / 2.0).coerceAtLeast(0.0)).toFloat(),
                  size = size,
                  color = op.optString("color", "#f8fafc"),
                  align = "center",
                  bold = true,
                  font = op.optString("font"),
                  maxWidth = op.optDouble("maxWidth", width.toDouble()).toFloat()
                )
              }
            }
          }
          "text" -> {
            drawTextOp(
              canvas,
              text = op.optString("text"),
              x = op.getDouble("x").toFloat(),
              y = op.getDouble("y").toFloat(),
              size = op.optDouble("size", 32.0).toFloat(),
              color = op.optString("color", "#f8fafc"),
              align = op.optString("align"),
              bold = op.optBoolean("bold"),
              font = op.optString("font"),
              maxWidth = op.optDouble("maxWidth", width.toDouble()).toFloat()
            )
          }
          else -> error("Unknown menu draw operation.")
        }
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

  override fun definition() = ModuleDefinition {
    Name("QuestPanel")

    Function("isAvailable") { available }

    Function("refSpaceEpoch") { if (available) nativeRefSpaceEpoch() else 0 }

    Function("open") { menuSlot.open() }
    Function("status") { id: Int -> menuSlot.status(id) }
    Function("draw") { id: Int, json: String -> menuSlot.enqueueDraw(id, json) }
    Function("invalidate") { id: Int -> menuSlot.invalidate(id) }
    Function("hide") { id: Int -> menuSlot.hide(id) }

    Function("openTitle") { titleSlot.open() }
    Function("statusTitle") { id: Int -> titleSlot.status(id) }
    Function("drawTitle") { id: Int, json: String -> titleSlot.enqueueDraw(id, json) }
    Function("invalidateTitle") { id: Int -> titleSlot.invalidate(id) }
    Function("hideTitle") { id: Int -> titleSlot.hide(id) }

    Function("exitApp") {
      val reactContext = appContext.reactContext ?: return@Function false
      Handler(Looper.getMainLooper()).post {
        try {
          appContext.currentActivity?.finishAndRemoveTask()
          val am = reactContext.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
          am?.appTasks?.forEach { task ->
            try {
              task.finishAndRemoveTask()
            } catch (_: Throwable) {
            }
          }
        } catch (error: Throwable) {
          Log.w(TAG, "exitApp failed", error)
        }
      }
      true
    }

    OnDestroy {
      menuSlot.destroy()
      titleSlot.destroy()
      releaseAssets()
      drawExecutor.shutdown()
    }
  }
}
