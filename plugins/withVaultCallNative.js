const { withAndroidManifest, withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

function patchManifest(manifest) {
  const perms = [
    "android.permission.INTERNET",
    "android.permission.RECORD_AUDIO",
    "android.permission.READ_PHONE_STATE",
    "android.permission.READ_CALL_LOG",
    "android.permission.READ_CONTACTS",
    "android.permission.SYSTEM_ALERT_WINDOW",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_MICROPHONE"
  ];
  manifest.manifest["uses-permission"] = manifest.manifest["uses-permission"] || [];
  const existing = new Set(
    manifest.manifest["uses-permission"].map((p) => p.$ && p.$["android:name"])
  );
  for (const perm of perms) {
    if (!existing.has(perm)) {
      manifest.manifest["uses-permission"].push({ $: { "android:name": perm } });
    }
  }

  const app = manifest.manifest.application && manifest.manifest.application[0];
  if (app) {
    app.receiver = app.receiver || [];
    if (!app.receiver.some((r) => r.$ && r.$["android:name"] === ".IncomingCallReceiver")) {
      app.receiver.push({
        $: {
          "android:name": ".IncomingCallReceiver",
          "android:enabled": "true",
          "android:exported": "true"
        },
        "intent-filter": [
          {
            action: [{ $: { "android:name": "android.intent.action.PHONE_STATE" } }]
          }
        ]
      });
    }

    app.service = app.service || [];
    if (!app.service.some((s) => s.$ && s.$["android:name"] === ".RecordingService")) {
      app.service.push({
        $: {
          "android:name": ".RecordingService",
          "android:enabled": "true",
          "android:exported": "false",
          "android:foregroundServiceType": "microphone"
        }
      });
    }
  }
  return manifest;
}

function buildKotlinFiles(pkgName) {
  const callerOverlayKt = `package ${pkgName}

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

object CallerOverlayController {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var overlayView: View? = null
    private var windowManager: WindowManager? = null

    fun showPopup(context: Context, number: String?, name: String, notes: String, sourceLabel: String) {
        mainHandler.post {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(context)) {
                return@post
            }
            dismissPopup()
            val wm = context.applicationContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            windowManager = wm

            val card = LinearLayout(context.applicationContext).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(36, 30, 36, 30)
                background = GradientDrawable().apply {
                    setColor(Color.parseColor("#0F172A"))
                    cornerRadius = 28f
                    setStroke(3, Color.parseColor("#4F46E5"))
                }
            }

            val titleTv = TextView(context.applicationContext).apply {
                text = "VaultCall - " + name
                setTextColor(Color.parseColor("#F8FAFC"))
                textSize = 18f
            }

            val subTv = TextView(context.applicationContext).apply {
                text = (number ?: "Unknown") + " [" + sourceLabel + "]"
                setTextColor(Color.parseColor("#93C5FD"))
                textSize = 13f
                setPadding(0, 6, 0, 10)
            }

            val notesTv = TextView(context.applicationContext).apply {
                text = if (notes.isBlank()) "No extra notes saved." else notes
                setTextColor(Color.parseColor("#D1FAE5"))
                textSize = 14f
                setPadding(0, 0, 0, 18)
            }

            val row = LinearLayout(context.applicationContext).apply {
                orientation = LinearLayout.HORIZONTAL
            }

            val recBtn = Button(context.applicationContext).apply {
                text = "Record Audio"
                setBackgroundColor(Color.parseColor("#059669"))
                setTextColor(Color.WHITE)
                setOnClickListener {
                    val intent = Intent(context.applicationContext, RecordingService::class.java).apply {
                        action = RecordingService.ACTION_START
                        putExtra(RecordingService.EXTRA_NUMBER, number ?: "Unknown")
                        putExtra(RecordingService.EXTRA_NAME, name)
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        context.applicationContext.startForegroundService(intent)
                    } else {
                        context.applicationContext.startService(intent)
                    }
                    text = "Recording..."
                }
            }

            val closeBtn = Button(context.applicationContext).apply {
                text = "Dismiss"
                setBackgroundColor(Color.parseColor("#334155"))
                setTextColor(Color.WHITE)
                setOnClickListener { dismissPopup() }
            }

            row.addView(recBtn)
            row.addView(closeBtn, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { marginStart = 16 })

            card.addView(titleTv)
            card.addView(subTv)
            card.addView(notesTv)
            card.addView(row)

            val flag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            } else {
                @Suppress("DEPRECATION")
                WindowManager.LayoutParams.TYPE_PHONE
            }

            val params = WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                flag,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED,
                PixelFormat.TRANSLUCENT
            ).apply {
                gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
                y = 80
            }

            overlayView = card
            wm.addView(card, params)
        }
    }

    fun dismissPopup() {
        mainHandler.post {
            try {
                overlayView?.let { windowManager?.removeView(it) }
            } catch (_: Exception) {
            } finally {
                overlayView = null
            }
        }
    }
}
`;

  const recordingServiceKt = `package ${pkgName}

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class RecordingService : Service() {
    private var recorder: MediaRecorder? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopRec()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        val num = intent?.getStringExtra(EXTRA_NUMBER) ?: "Unknown"
        val name = intent?.getStringExtra(EXTRA_NAME) ?: "Unknown Caller"
        createChannel()
        startForeground(NOTIF_ID, buildNotif(name, num))
        startRec(num)
        return START_STICKY
    }

    private fun startRec(number: String) {
        stopRec()
        try {
            val dir = File(getExternalFilesDir(null) ?: filesDir, "vaultcall_recordings")
            if (!dir.exists()) dir.mkdirs()
            val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
            val digits = number.filter { it.isDigit() }.takeLast(10).ifEmpty { "call" }
            val file = File(dir, "rec_" + digits + "_" + stamp + ".m4a")
            val rec = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(this) else @Suppress("DEPRECATION") MediaRecorder()
            rec.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setOutputFile(file.absolutePath)
                prepare()
                start()
            }
            recorder = rec
        } catch (_: Exception) {
            recorder = null
        }
    }

    private fun stopRec() {
        try {
            recorder?.stop()
            recorder?.release()
        } catch (_: Exception) {
        } finally {
            recorder = null
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "VaultCall Recording", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
    }

    private fun buildNotif(name: String, number: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("VaultCall Recording")
            .setContentText(name + " (" + number + ")")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        stopRec()
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "${pkgName}.START_REC"
        const val ACTION_STOP = "${pkgName}.STOP_REC"
        const val EXTRA_NUMBER = "extra_number"
        const val EXTRA_NAME = "extra_name"
        private const val CHANNEL_ID = "vaultcall_rec_ch"
        private const val NOTIF_ID = 3001
    }
}
`;

  const incomingReceiverKt = `package ${pkgName}

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.ContactsContract
import android.telephony.TelephonyManager
import org.json.JSONArray

class IncomingCallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return
        val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE)
        @Suppress("DEPRECATION")
        val incoming = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)

        when (state) {
            TelephonyManager.EXTRA_STATE_RINGING -> {
                val (name, notes, source) = lookupCaller(context, incoming)
                CallerOverlayController.showPopup(context, incoming, name, notes, source)
                val prefs = context.getSharedPreferences("VaultCallNativePrefs", Context.MODE_PRIVATE)
                if (prefs.getBoolean("auto_record", false)) {
                    val recIntent = Intent(context, RecordingService::class.java).apply {
                        action = RecordingService.ACTION_START
                        putExtra(RecordingService.EXTRA_NUMBER, incoming ?: "Unknown")
                        putExtra(RecordingService.EXTRA_NAME, name)
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        context.startForegroundService(recIntent)
                    } else {
                        context.startService(recIntent)
                    }
                }
            }
            TelephonyManager.EXTRA_STATE_IDLE -> {
                context.startService(Intent(context, RecordingService::class.java).apply {
                    action = RecordingService.ACTION_STOP
                })
                CallerOverlayController.dismissPopup()
            }
        }
    }

    private fun norm(raw: String?): String {
        val d = (raw ?: "").filter { it.isDigit() }
        return if (d.length > 10) d.takeLast(10) else d
    }

    private fun lookupCaller(context: Context, phone: String?): Triple<String, String, String> {
        val target = norm(phone)
        if (target.isEmpty()) return Triple("Unknown Caller", "", "No Number")

        val prefs = context.getSharedPreferences("VaultCallNativePrefs", Context.MODE_PRIVATE)
        val rawExtra = prefs.getString("vault_extra_contacts", "[]") ?: "[]"
        try {
            val arr = JSONArray(rawExtra)
            for (i in 0 until arr.length()) {
                val obj = arr.optJSONObject(i) ?: continue
                if (norm(obj.optString("phone")) == target) {
                    val n = obj.optString("name", "Vault Contact")
                    val note = obj.optString("notes", "")
                    return Triple(n, note, "Vault Extra")
                }
            }
        } catch (_: Exception) {}

        try {
            val uri = ContactsContract.CommonDataKinds.Phone.CONTENT_URI
            context.contentResolver.query(
                uri,
                arrayOf(
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                    ContactsContract.CommonDataKinds.Phone.NUMBER
                ),
                null,
                null,
                null
            )?.use { cursor ->
                val nameIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
                val numIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
                while (cursor.moveToNext()) {
                    val num = if (numIdx >= 0) cursor.getString(numIdx) else ""
                    if (norm(num) == target) {
                        val name = if (nameIdx >= 0) cursor.getString(nameIdx) else "Phone Contact"
                        return Triple(name ?: "Phone Contact", "From your phone contacts", "Phone Book")
                    }
                }
            }
        } catch (_: Exception) {}

        return Triple("Unknown Caller", "Not in Vault or your Phone Contacts", "Unknown")
    }
}
`;

  const vaultBridgeKt = `package ${pkgName}

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.CallLog
import android.provider.ContactsContract
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class VaultBridgeModule(private val reactCtx: ReactApplicationContext) : ReactContextBaseJavaModule(reactCtx) {

    override fun getName(): String = "VaultBridge"

    @ReactMethod
    fun syncExtraContacts(jsonStr: String, autoRecord: Boolean) {
        val prefs = reactCtx.getSharedPreferences("VaultCallNativePrefs", Context.MODE_PRIVATE)
        prefs.edit()
            .putString("vault_extra_contacts", jsonStr)
            .putBoolean("auto_record", autoRecord)
            .apply()
    }

    @ReactMethod
    fun canDrawOverlays(promise: Promise) {
        val allowed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Settings.canDrawOverlays(reactCtx)
        } else true
        promise.resolve(allowed)
    }

    @ReactMethod
    fun requestOverlayPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(reactCtx)) {
            val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + reactCtx.packageName))
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactCtx.startActivity(intent)
        }
    }

    @ReactMethod
    fun showNativePopup(number: String, name: String, notes: String, sourceLabel: String) {
        CallerOverlayController.showPopup(reactCtx, number, name, notes, sourceLabel)
    }

    @ReactMethod
    fun getPhoneContacts(promise: Promise) {
        try {
            val arr = Arguments.createArray()
            val seen = HashSet<String>()
            val uri = ContactsContract.CommonDataKinds.Phone.CONTENT_URI
            reactCtx.contentResolver.query(
                uri,
                arrayOf(
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                    ContactsContract.CommonDataKinds.Phone.NUMBER
                ),
                null,
                null,
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC"
            )?.use { cursor ->
                val nIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
                val pIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
                while (cursor.moveToNext() && arr.size() < 500) {
                    val name = if (nIdx >= 0) (cursor.getString(nIdx) ?: "") else ""
                    val phone = if (pIdx >= 0) (cursor.getString(pIdx) ?: "") else ""
                    val key = name + "|" + phone
                    if (phone.isNotBlank() && !seen.contains(key)) {
                        seen.add(key)
                        val map = Arguments.createMap()
                        map.putString("name", name)
                        map.putString("phone", phone)
                        arr.pushMap(map)
                    }
                }
            }
            promise.resolve(arr)
        } catch (ex: Exception) {
            promise.reject("CONTACTS_ERR", ex.message, ex)
        }
    }

    @ReactMethod
    fun getInternalCallLogs(promise: Promise) {
        try {
            val arr = Arguments.createArray()
            val fmt = SimpleDateFormat("dd MMM, hh:mm a", Locale.getDefault())
            reactCtx.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                arrayOf(
                    CallLog.Calls.NUMBER,
                    CallLog.Calls.CACHED_NAME,
                    CallLog.Calls.TYPE,
                    CallLog.Calls.DATE
                ),
                null,
                null,
                CallLog.Calls.DATE + " DESC"
            )?.use { cursor ->
                val numIdx = cursor.getColumnIndex(CallLog.Calls.NUMBER)
                val nameIdx = cursor.getColumnIndex(CallLog.Calls.CACHED_NAME)
                val typeIdx = cursor.getColumnIndex(CallLog.Calls.TYPE)
                val dateIdx = cursor.getColumnIndex(CallLog.Calls.DATE)
                while (cursor.moveToNext() && arr.size() < 50) {
                    val number = if (numIdx >= 0) (cursor.getString(numIdx) ?: "Unknown") else "Unknown"
                    val cachedName = if (nameIdx >= 0) (cursor.getString(nameIdx) ?: "") else ""
                    val typeCode = if (typeIdx >= 0) cursor.getInt(typeIdx) else 0
                    val dateMs = if (dateIdx >= 0) cursor.getLong(dateIdx) else 0L
                    val callType = when (typeCode) {
                        CallLog.Calls.INCOMING_TYPE -> "Incoming"
                        CallLog.Calls.OUTGOING_TYPE -> "Outgoing"
                        CallLog.Calls.MISSED_TYPE -> "Missed"
                        else -> "Call"
                    }
                    val map = Arguments.createMap()
                    map.putString("number", number)
                    map.putString("phoneName", cachedName)
                    map.putString("callType", callType)
                    map.putString("createdAt", if (dateMs > 0L) fmt.format(Date(dateMs)) else "")
                    arr.pushMap(map)
                }
            }
            promise.resolve(arr)
        } catch (ex: Exception) {
            promise.reject("CALLLOG_ERR", ex.message, ex)
        }
    }
}
`;

  const vaultPackageKt = `package ${pkgName}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class VaultPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(VaultBridgeModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
`;

  return {
    callerOverlayKt,
    recordingServiceKt,
    incomingReceiverKt,
    vaultBridgeKt,
    vaultPackageKt,
  };
}

function registerVaultPackageInMainApp(appKt) {
  if (appKt.includes("VaultPackage()")) return appKt;
  let updated = appKt;

  if (!updated.includes("com.facebook.react.ReactPackage")) {
    updated = updated.replace(
      /^(package\s+[^\r\n]+)/m,
      "$1\n\nimport com.facebook.react.ReactPackage"
    );
  }

  if (updated.includes("PackageList(this).packages.apply {")) {
    updated = updated.replace(
      "PackageList(this).packages.apply {",
      "PackageList(this).packages.apply {\n              add(VaultPackage())"
    );
  } else if (/override fun getPackages\(\): ArrayList<ReactPackage>\s*=\s*PackageList\(this\)\.packages\.apply\s*\{/.test(updated)) {
    updated = updated.replace(
      /(override fun getPackages\(\): ArrayList<ReactPackage>\s*=\s*PackageList\(this\)\.packages\.apply\s*\{)/,
      "$1\n              add(VaultPackage())"
    );
  } else if (/override fun getPackages\(\): List<ReactPackage>\s*=\s*PackageList\(this\)\.packages/.test(updated)) {
    updated = updated.replace(
      /override fun getPackages\(\): List<ReactPackage>\s*=\s*PackageList\(this\)\.packages/,
      "override fun getPackages(): List<ReactPackage> =\n        PackageList(this).packages.apply { add(VaultPackage()) }"
    );
  }

  return updated;
}

module.exports = function withVaultCallNative(config) {
  const pkgName = (config.android && config.android.package) || "com.vaultcall.app";

  config = withAndroidManifest(config, (cfg) => {
    cfg.modResults = patchManifest(cfg.modResults);
    return cfg;
  });

  config = withDangerousMod(config, [
    "android",
    async (cfg) => {
      const pkgParts = pkgName.split(".");
      const pkgDir = path.join(
        cfg.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "java",
        ...pkgParts
      );
      fs.mkdirSync(pkgDir, { recursive: true });
      const files = buildKotlinFiles(pkgName);
      fs.writeFileSync(path.join(pkgDir, "CallerOverlayController.kt"), files.callerOverlayKt, "utf8");
      fs.writeFileSync(path.join(pkgDir, "RecordingService.kt"), files.recordingServiceKt, "utf8");
      fs.writeFileSync(path.join(pkgDir, "IncomingCallReceiver.kt"), files.incomingReceiverKt, "utf8");
      fs.writeFileSync(path.join(pkgDir, "VaultBridgeModule.kt"), files.vaultBridgeKt, "utf8");
      fs.writeFileSync(path.join(pkgDir, "VaultPackage.kt"), files.vaultPackageKt, "utf8");

      const mainAppPath = path.join(pkgDir, "MainApplication.kt");
      if (fs.existsSync(mainAppPath)) {
        const currentKt = fs.readFileSync(mainAppPath, "utf8");
        const nextKt = registerVaultPackageInMainApp(currentKt);
        if (nextKt !== currentKt) {
          fs.writeFileSync(mainAppPath, nextKt, "utf8");
        }
      }
      return cfg;
    }
  ]);

  return config;
};