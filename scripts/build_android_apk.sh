#!/usr/bin/env bash
set -euo pipefail

export JAVA_HOME="/tmp/android-sdk/jdk17"
export PATH="$JAVA_HOME/bin:/tmp/android-sdk/android-14:$PATH"

ANDROID_JAR="/tmp/android-sdk/android-34/android.jar"
AAPT2="/tmp/android-sdk/android-14/aapt2"
D8="/tmp/android-sdk/android-14/d8"
ZIPALIGN="/tmp/android-sdk/android-14/zipalign"
APKSIGNER="/tmp/android-sdk/android-14/apksigner"

PROJECT_DIR="/app/applet/android-app"
BUILD_DIR="/tmp/domru-apk-build"
OUT_APK="/app/applet/public/domru-lab-poco-x6-pro.apk"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/compiled_res" "$BUILD_DIR/gen" "$BUILD_DIR/classes" "$BUILD_DIR/dex"

echo "[1/6] Compiling Android resources with aapt2..."
"$AAPT2" compile --dir "$PROJECT_DIR/res" -o "$BUILD_DIR/compiled_res/res.zip"

echo "[2/6] Linking resources and generating R.java + base APK..."
"$AAPT2" link \
  -I "$ANDROID_JAR" \
  --manifest "$PROJECT_DIR/AndroidManifest.xml" \
  --java "$BUILD_DIR/gen" \
  -o "$BUILD_DIR/unaligned.apk" \
  "$BUILD_DIR/compiled_res/res.zip"

echo "[3/6] Compiling all native Java source files with OpenJDK 17 javac (target 8)..."
javac \
  -source 8 \
  -target 8 \
  -encoding UTF-8 \
  -bootclasspath "$ANDROID_JAR" \
  -classpath "$ANDROID_JAR" \
  -d "$BUILD_DIR/classes" \
  "$BUILD_DIR/gen/ru/domrulab/pocox6pro/R.java" \
  "$PROJECT_DIR/src/ru/domrulab/pocox6pro/SoundGenerator.java" \
  "$PROJECT_DIR/src/ru/domrulab/pocox6pro/AndroidKeyStoreVault.java" \
  "$PROJECT_DIR/src/ru/domrulab/pocox6pro/OnDeviceFaceCvEngine.java" \
  "$PROJECT_DIR/src/ru/domrulab/pocox6pro/DomRuApiClient.java" \
  "$PROJECT_DIR/src/ru/domrulab/pocox6pro/DomRuGeofenceService.java" \
  "$PROJECT_DIR/src/ru/domrulab/pocox6pro/MainActivity.java"

echo "[4/6] Converting JVM bytecode to Dalvik Executable (classes.dex) with d8..."
CLASS_FILES=$(find "$BUILD_DIR/classes" -name "*.class")
"$D8" \
  --lib "$ANDROID_JAR" \
  --min-api 26 \
  --output "$BUILD_DIR/dex" \
  $CLASS_FILES

echo "[5/6] Packaging classes.dex into APK and running zipalign..."
python3 -c '
import zipfile, shutil
shutil.copy("/tmp/domru-apk-build/unaligned.apk", "/tmp/domru-apk-build/with_dex.apk")
with zipfile.ZipFile("/tmp/domru-apk-build/with_dex.apk", "a", compression=zipfile.ZIP_DEFLATED) as zf:
    zf.write("/tmp/domru-apk-build/dex/classes.dex", "classes.dex")
'

"$ZIPALIGN" -f -p 4 "$BUILD_DIR/with_dex.apk" "$BUILD_DIR/aligned.apk"

echo "[6/6] Generating signing keystore and signing APK (v1 + v2 + v3 schemes)..."
KEYSTORE="$BUILD_DIR/domru-release.jks"
keytool -genkeypair \
  -v \
  -keystore "$KEYSTORE" \
  -alias domrulab \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -storepass domrulab2026 \
  -keypass domrulab2026 \
  -dname "CN=DomRu Lab Poco X6 Pro, OU=Mobile CV, O=DomRu Lab, L=Novosibirsk, ST=Nsk, C=RU"

"$APKSIGNER" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias domrulab \
  --ks-pass pass:domrulab2026 \
  --key-pass pass:domrulab2026 \
  --v1-signing-enabled true \
  --v2-signing-enabled true \
  --v3-signing-enabled true \
  --out "$OUT_APK" \
  "$BUILD_DIR/aligned.apk"

echo "=== Verifying signed APK ==="
"$APKSIGNER" verify --verbose --print-certs "$OUT_APK"
ls -lh "$OUT_APK"
