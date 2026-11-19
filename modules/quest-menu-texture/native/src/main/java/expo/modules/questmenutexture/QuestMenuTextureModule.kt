package expo.modules.questmenutexture

import android.annotation.SuppressLint
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
import android.text.TextPaint
import android.text.TextUtils
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.lang.reflect.InvocationTargetException
import java.security.MessageDigest

private const val TAG = "QuestMenuTexture"

// Rasterizes the headset menu to a cache PNG. Drawing stays in this process.
//
// ViroMaterials.createMaterials is an async void call. Viro decodes the PNG on
// the native-modules thread and only then stores the material. A quad mounted
// first logs "Material [x] not found" and keeps Viro's default white material
// with no retry. A decode that returns null stores a material with no texture,
// which is also white. prepareMaterial registers the material on that same
// thread and resolves only after Viro returns a texture of the file's size, so
// the scene never mounts a quad on a missing or empty material. Viro is reached
// by module name and reflection; this module does not link react_viro.
class QuestMenuTextureModule : Module() {
  private val drawLock = Any()
  private val typefaces = HashMap<String, Typeface>()

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

  // Release drawables and raw fonts are resource names, not filesystem paths.
  // Copy those bytes into the cache once so Canvas and Typeface can read them.
  private fun materialize(value: String, extension: String): File {
    existingFile(value)?.let { return it }
    val context = appContext.reactContext ?: error("Menu texture has no Android context.")
    val input = openPackaged(context, value) ?: error("Menu texture asset is not a file: $value")
    val directory = File(context.cacheDir, "quest-menu-src")
    if (!directory.isDirectory && !directory.mkdirs()) error("Menu texture cache directory was not created.")
    val file = File(directory, sourceCacheName(value, extension))
    if (file.isFile && file.length() > 0L) {
      input.close()
      return file
    }
    try {
      input.use { stream ->
        FileOutputStream(file).use { out ->
          val copied = stream.copyTo(out)
          if (copied <= 0L) error("Menu texture asset was empty: $value")
        }
      }
    } catch (failure: Exception) {
      file.delete()
      throw failure
    }
    return file
  }

  private fun typeface(path: String): Typeface {
    val file = materialize(path, "ttf")
    typefaces[file.absolutePath]?.let { return it }
    val face = Typeface.createFromFile(file)
    typefaces[file.absolutePath] = face
    return face
  }

  private fun renderToFile(json: String): String {
    val spec = JSONObject(json)
    val width = spec.getInt("width")
    val height = spec.getInt("height")
    val ops = spec.getJSONArray("ops")
    require(width in 1..4096 && height in 1..4096) { "Menu texture size is out of range." }
    require(ops.length() in 1..160) { "Menu texture has no drawing operations." }
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
          "image" -> {
            val imageUri = op.getString("uri")
            val source = BitmapFactory.decodeFile(materialize(imageUri, "png").absolutePath)
              ?: error("Menu texture image could not be decoded: $imageUri")
            try {
              paint.style = Paint.Style.FILL
              paint.color = Color.WHITE
              canvas.drawBitmap(
                source,
                null,
                RectF(
                  op.getDouble("x").toFloat(),
                  op.getDouble("y").toFloat(),
                  (op.getDouble("x") + op.getDouble("width")).toFloat(),
                  (op.getDouble("y") + op.getDouble("height")).toFloat()
                ),
                paint
              )
            } finally {
              source.recycle()
            }
          }
          "text" -> {
            val text = op.optString("text")
            if (text.isEmpty()) continue
            val size = op.optDouble("size", 32.0).toFloat()
            val maxWidth = op.optDouble("maxWidth", width.toDouble()).toFloat()
            val glyph = TextPaint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG)
            glyph.color = Color.parseColor(op.optString("color", "#f8fafc"))
            glyph.textSize = size
            val font = op.optString("font")
            glyph.typeface =
              if (font.isNotEmpty()) typeface(font)
              else if (op.optBoolean("bold")) Typeface.DEFAULT_BOLD
              else Typeface.DEFAULT
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
          else -> error("Unknown menu draw operation.")
        }
      }
      // These pixels show what Canvas drew, not what the headset displays.
      val probe = JSONArray()
      for ((px, py) in listOf(width / 2 to height / 2, width / 4 to height * 7 / 8, 8 to 8)) {
        probe.put("%08X".format(bitmap.getPixel(px, py)))
      }
      val context = appContext.reactContext ?: error("Menu texture has no Android context.")
      val directory = File(context.cacheDir, "quest-menu")
      directory.mkdirs()
      val file = File(directory, "panel-${System.nanoTime()}.png")
      FileOutputStream(file).use { stream ->
        if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream))
          error("Menu texture PNG encoding failed.")
      }
      val keep = mutableSetOf(file.absolutePath)
      val keepJson = spec.optJSONArray("keep")
      if (keepJson != null) {
        for (index in 0 until keepJson.length()) {
          val value = keepJson.optString(index)
          if (value.isNotEmpty()) {
            val kept = existingFile(value)
            if (kept != null) keep.add(kept.absolutePath)
          }
        }
      }
      directory.listFiles()?.forEach { cached ->
        if (cached.absolutePath !in keep && cached.name.startsWith("panel-")) cached.delete()
      }
      return JSONObject()
        .put("uri", Uri.fromFile(file).toString())
        .put("width", width)
        .put("height", height)
        .put("probe", probe)
        .toString()
    } finally {
      bitmap.recycle()
    }
  }

  private fun panelFile(value: String): File? {
    val file = existingFile(value) ?: return null
    val context = appContext.reactContext ?: return null
    val directory = File(context.cacheDir, "quest-menu").canonicalFile
    val inside = file.canonicalFile.parentFile == directory && file.name.startsWith("panel-")
    return if (inside) file else null
  }

  private fun viroMaterialManager(context: ReactContext): Any =
    context.getNativeModule("VRTMaterialManager")
      ?: error("Viro MaterialManager (VRTMaterialManager) is not loaded.")

  // Runs on the queue Viro uses for setJSMaterials, so a JS createMaterials
  // call and this one never interleave.
  private fun onViroQueue(promise: Promise, code: String, work: (Any) -> Any?) {
    val context = appContext.reactContext as? ReactContext
    if (context == null) {
      promise.reject(code, "Menu material has no React context.", null)
      return
    }
    context.runOnNativeModulesQueueThread {
      try {
        promise.resolve(work(viroMaterialManager(context)))
      } catch (failure: Throwable) {
        val cause = (failure as? InvocationTargetException)?.targetException ?: failure
        val message = cause.message ?: cause.toString()
        Log.e(TAG, "$code $message")
        promise.reject(code, message, cause)
      }
    }
  }

  private fun deleteViroMaterials(manager: Any, names: List<String>) {
    if (names.isEmpty()) return
    val array = Arguments.createArray()
    names.forEach { array.pushString(it) }
    manager.javaClass.getMethod("deleteMaterials", ReadableArray::class.java).invoke(manager, array)
  }

  private fun prepare(manager: Any, name: String, uri: String): String {
    require(name.startsWith("questMenu-")) { "Not a menu material name: $name" }
    val file = panelFile(uri) ?: error("Menu texture file is missing before Viro loads it: $uri")
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0)
      error("Menu texture is not a decodable PNG: $uri (${file.length()} bytes)")
    val texture = Arguments.createMap()
    texture.putString("uri", uri)
    texture.putString("type", "png")
    val material = Arguments.createMap()
    material.putMap("diffuseTexture", texture)
    material.putString("lightingModel", "Constant")
    material.putString("blendMode", "Alpha")
    material.putString("cullMode", "None")
    material.putString("minificationFilter", "Linear")
    material.putString("magnificationFilter", "Linear")
    material.putString("mipFilter", "Linear")
    val materials = Arguments.createMap()
    materials.putMap(name, material)
    val started = System.nanoTime()
    manager.javaClass.getMethod("setJSMaterials", ReadableMap::class.java).invoke(manager, materials)
    val native = manager.javaClass.getMethod("getMaterial", String::class.java).invoke(manager, name)
      ?: error("Viro did not register material $name.")
    val diffuse = native.javaClass.getMethod("getDiffuseTexture").invoke(native)
    if (diffuse == null) {
      deleteViroMaterials(manager, listOf(name))
      error("Viro stored $name without a texture; its image loader returned nothing for $uri.")
    }
    val textureWidth = diffuse.javaClass.getMethod("getWidth").invoke(diffuse) as Int
    val textureHeight = diffuse.javaClass.getMethod("getHeight").invoke(diffuse) as Int
    if (textureWidth != bounds.outWidth || textureHeight != bounds.outHeight) {
      deleteViroMaterials(manager, listOf(name))
      error(
        "Viro texture for $name is ${textureWidth}x$textureHeight; " +
          "the file is ${bounds.outWidth}x${bounds.outHeight}."
      )
    }
    val ms = (System.nanoTime() - started) / 1_000_000
    Log.i(TAG, "prepared $name ${textureWidth}x$textureHeight in ${ms}ms from $uri")
    return JSONObject()
      .put("name", name)
      .put("width", textureWidth)
      .put("height", textureHeight)
      .put("ms", ms)
      .toString()
  }

  // Deleting a material does not detach it from a mounted quad; the geometry
  // keeps its own reference. Files are deleted here because Viro re-reads every
  // registered material's file when a scene navigator detaches.
  private fun release(manager: Any, names: List<String>, uris: List<String>): Int {
    deleteViroMaterials(manager, names.filter { it.startsWith("questMenu-") })
    var deleted = 0
    for (uri in uris) {
      val file = panelFile(uri) ?: continue
      if (file.delete()) deleted += 1
    }
    Log.i(TAG, "released ${names.size} materials and $deleted files")
    return deleted
  }

  override fun definition() = ModuleDefinition {
    Name("QuestMenuTexture")

    AsyncFunction("render") { json: String ->
      synchronized(drawLock) { renderToFile(json) }
    }

    AsyncFunction("prepareMaterial") { name: String, uri: String, promise: Promise ->
      onViroQueue(promise, "ERR_QUEST_MENU_MATERIAL") { manager -> prepare(manager, name, uri) }
    }

    AsyncFunction("releaseMaterials") { names: List<String>, uris: List<String>, promise: Promise ->
      onViroQueue(promise, "ERR_QUEST_MENU_RELEASE") { manager -> release(manager, names, uris) }
    }
  }
}
