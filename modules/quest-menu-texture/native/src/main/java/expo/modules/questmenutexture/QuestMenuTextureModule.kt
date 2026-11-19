package expo.modules.questmenutexture

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.RectF
import android.graphics.Typeface
import android.net.Uri
import android.text.TextPaint
import android.text.TextUtils
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

// Rasterizes the headset menu to a cache PNG. Drawing stays in this process.
class QuestMenuTextureModule : Module() {
  private val drawLock = Any()

  private fun renderToFile(json: String): String {
    val spec = JSONObject(json)
    val width = spec.getInt("width")
    val height = spec.getInt("height")
    val ops = spec.getJSONArray("ops")
    require(width in 1..4096 && height in 1..4096) { "Menu texture size is out of range." }
    require(ops.length() in 1..64) { "Menu texture has no drawing operations." }
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    try {
      val canvas = Canvas(bitmap)
      canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
      val paint = Paint(Paint.ANTI_ALIAS_FLAG)
      for (index in 0 until ops.length()) {
        val op = ops.getJSONObject(index)
        when (op.getString("op")) {
          "roundRect" -> {
            paint.style = Paint.Style.FILL
            paint.color = Color.parseColor(op.getString("color"))
            canvas.drawRoundRect(
              RectF(
                op.getDouble("x").toFloat(),
                op.getDouble("y").toFloat(),
                (op.getDouble("x") + op.getDouble("width")).toFloat(),
                (op.getDouble("y") + op.getDouble("height")).toFloat()
              ),
              op.optDouble("radius", 0.0).toFloat(),
              op.optDouble("radius", 0.0).toFloat(),
              paint
            )
          }
          "text" -> {
            val text = op.optString("text")
            if (text.isEmpty()) continue
            val size = op.optDouble("size", 32.0).toFloat()
            val maxWidth = op.optDouble("maxWidth", width.toDouble()).toFloat()
            val glyph = TextPaint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG)
            glyph.color = Color.parseColor(op.optString("color", "#f8fafc"))
            glyph.textSize = size
            glyph.typeface = if (op.optBoolean("bold")) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
            glyph.textAlign =
              if (op.optString("align") == "center") Paint.Align.CENTER else Paint.Align.LEFT
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
        }
      }
      val context = appContext.reactContext ?: error("Menu texture has no Android context.")
      val directory = File(context.cacheDir, "quest-menu")
      directory.mkdirs()
      val file = File(directory, "panel-${System.nanoTime()}.png")
      FileOutputStream(file).use { stream ->
        if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream))
          error("Menu texture PNG encoding failed.")
      }
      directory.listFiles()?.sortedBy { it.name }?.dropLast(2)?.forEach { it.delete() }
      return JSONObject()
        .put("uri", Uri.fromFile(file).toString())
        .put("width", width)
        .put("height", height)
        .toString()
    } finally {
      bitmap.recycle()
    }
  }

  override fun definition() = ModuleDefinition {
    Name("QuestMenuTexture")

    AsyncFunction("render") { json: String ->
      synchronized(drawLock) { renderToFile(json) }
    }
  }
}
