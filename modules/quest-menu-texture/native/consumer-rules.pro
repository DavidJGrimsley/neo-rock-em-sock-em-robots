-keep class expo.modules.questmenutexture.QuestMenuTextureModule { *; }
# Called by reflection from QuestMenuTextureModule.prepareMaterial/releaseMaterials.
-keepclassmembers class com.viromedia.bridge.module.MaterialManager { public void setJSMaterials(...); public void deleteMaterials(...); public com.viro.core.Material getMaterial(java.lang.String); }
-keepclassmembers class com.viro.core.Material { public com.viro.core.Texture getDiffuseTexture(); }
-keepclassmembers class com.viro.core.Texture { public int getWidth(); public int getHeight(); }
