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
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_MICROPHONE",
    "android.permission.FOREGROUND_SERVICE_SPECIAL_USE"
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
    if (!app.service.some((s) => s.$ && s.$["android:name"] === ".CallerOverlayService")) {
      app.service.push({
        $: {
          "android:name": ".CallerOverlayService",
          "android:enabled": "true",
          "android:exported": "false",
          "android:foregroundServiceType": "specialUse"
        }
      });
    }

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
  const callerOverlayServiceKt = `package ${pkgName}

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat

class CallerOverlayService : Service() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var overlayView: View? = null
    private var windowManager: WindowManager? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_HIDE) {
            removeOverlay()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
            stopSelf()
            return START_NOT_STICKY
        }

        val number = intent?.getStringExtra(EXTRA_NUMBER) ?: "Unknown"
        val name = intent?.getStringExtra(EXTRA_NAME) ?: "Unknown Caller"
        val notes = intent?.getStringExtra(EXTRA_NOTES) ?: ""
        val sourceLabel = intent?.getStringExtra(EXTRA_SOURCE) ?: "VaultCall DB"

        ensureChannel()
        startForeground(NOTIF_ID, buildNotif(name, number, sourceLabel))
        showOverlay(number, name, notes, sourceLabel)
        return START_STICKY
    }

    private fun showOverlay(number: String, name: String, notes: String, sourceLabel: String) {
        mainHandler.post {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(applicationContext)) {
                return@post
            }
            removeOverlay()
            val wm = applicationContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            windowManager = wm

            val card = LinearLayout(applicationContext).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(36, 30, 36, 30)
                background = GradientDrawable().apply {
                    setColor(Color.parseColor("#0F172A"))
                    cornerRadius = 28f
                    setStroke(4, Color.parseColor("#6366F1"))
                }
            }

            val badgeTv = TextView(applicationContext).apply {
                text = "VAULTCALL DB CALLER ID • " + sourceLabel.uppercase()
                setTextColor(Color.parseColor("#A5B4FC"))
                textSize = 11f
            }

            val titleTv = TextView(applicationContext).apply {
                text = name
                setTextColor(Color.parseColor("#F8FAFC"))
                textSize = 20f
                setPadding(0, 4, 0, 2)
            }

            val subTv = TextView(applicationContext).apply {
                text = number
                setTextColor(Color.parseColor("#6EE7B7"))
                textSize = 15f
                setPadding(0, 0, 0, 8)
            }

            val notesTv = TextView(applicationContext).apply {
                text = if (notes.isBlank()) "Matched in your VaultCall database" else notes
                setTextColor(Color.parseColor("#E2E8F0"))
                textSize = 13f
                setPadding(0, 0, 0, 16)
            }

            val row = LinearLayout(applicationContext).apply {
                orientation = LinearLayout.HORIZONTAL
            }

            val recBtn = Button(applicationContext).apply {
                text = "Record"
                setBackgroundColor(Color.parseColor("#059669"))
                setTextColor(Color.WHITE)
                setOnClickListener {
                    val recIntent = Intent(applicationContext, RecordingService::class.java).apply {
                        action = RecordingService.ACTION_START
                        putExtra(RecordingService.EXTRA_NUMBER, number)
                        putExtra(RecordingService.EXTRA_NAME, name)
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        applicationContext.startForegroundService(recIntent)
                    } else {
                        applicationContext.startService(recIntent)
                    }
                    text = "Recording..."
                }
            }

            val closeBtn = Button(applicationContext).apply {
                text = "Close"
                setBackgroundColor(Color.parseColor("#334155"))
                setTextColor(Color.WHITE)
                setOnClickListener {
                    val stopIntent = Intent(applicationContext, CallerOverlayService::class.java).apply {
                        action = ACTION_HIDE
                    }
                    applicationContext.startService(stopIntent)
                }
            }

            row.addView(recBtn)
            row.addView(
                closeBtn,
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { marginStart = 16 }
            )

            card.addView(badgeTv)
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
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
                PixelFormat.TRANSLUCENT
            ).apply {
                gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
                x = 24
                y = 90
                width = WindowManager.LayoutParams.MATCH_PARENT
            }

            try {
                overlayView = card
                wm.addView(card, params)
            } catch (_: Exception) {
                overlayView = null
            }
        }
    }

    private fun removeOverlay() {
        try {
            overlayView?.let { windowManager?.removeView(it) }
        } catch (_: Exception) {
        } finally {
            overlayView = null
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CHANNEL_ID,
                "VaultCall Caller ID Pop-up",
                NotificationManager.IMPORTANCE_LOW
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
    }

    private fun buildNotif(name: String, number: String, sourceLabel: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("VaultCall • " + name + " [" + sourceLabel + "]")
            .setContentText(number)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        removeOverlay()
        super.onDestroy()
    }

    companion object {
        const val ACTION_SHOW = "${pkgName}.SHOW_OVERLAY"
        const val ACTION_HIDE = "${pkgName}.HIDE_OVERLAY"
        const val EXTRA_NUMBER = "extra_number"
        const val EXTRA_NAME = "extra_name"
        const val EXTRA_NOTES = "extra_notes"
        const val EXTRA_SOURCE = "extra_source"
        private const val CHANNEL_ID = "vaultcall_overlay_ch"
        private const val NOTIF_ID = 3002

        fun show(context: Context, number: String?, name: String, notes: String, sourceLabel: String) {
            val intent = Intent(context.applicationContext, CallerOverlayService::class.java).apply {
                action = ACTION_SHOW
                putExtra(EXTRA_NUMBER, number ?: "Unknown")
                putExtra(EXTRA_NAME, name)
                putExtra(EXTRA_NOTES, notes)
                putExtra(EXTRA_SOURCE, sourceLabel)
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.applicationContext.startForegroundService(intent)
                } else {
                    context.applicationContext.startService(intent)
                }
            } catch (_: Exception) {}
        }

        fun hide(context: Context) {
            val intent = Intent(context.applicationContext, CallerOverlayService::class.java).apply {
                action = ACTION_HIDE
            }
            try {
                context.applicationContext.startService(intent)
            } catch (_: Exception) {}
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
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
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
                val (name, notes, source) = lookupCallerFromVaultDb(context, incoming)
                CallerOverlayService.show(context, incoming, name, notes, source)
                val prefs = context.getSharedPreferences("VaultCallNativePrefs", Context.MODE_PRIVATE)
                if (prefs.getBoolean("auto_record", false)) {
                    val recIntent = Intent(context, RecordingService::class.java).apply {
                        action = RecordingService.ACTION_START
                        putExtra(RecordingService.EXTRA_NUMBER, incoming ?: "Unknown")
                        putExtra(RecordingService.EXTRA_NAME, name)
                    }
                    try {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            context.startForegroundService(recIntent)
                        } else {
                            context.startService(recIntent)
                        }
                    } catch (_: Exception) {}
                }
            }
            TelephonyManager.EXTRA_STATE_IDLE -> {
                try {
                    context.startService(Intent(context, RecordingService::class.java).apply {
                        action = RecordingService.ACTION_STOP
                    })
                } catch (_: Exception) {}
                CallerOverlayService.hide(context)
            }
        }
    }

    private fun norm(raw: String?): String {
        val d = (raw ?: "").filter { it.isDigit() }
        return if (d.length > 10) d.takeLast(10) else d
    }

    private fun lookupCallerFromVaultDb(context: Context, phone: String?): Triple<String, String, String> {
        val target = norm(phone)
        if (target.isEmpty()) return Triple("Incoming Call", "Number hidden by carrier", "Phone State")

        val prefs = context.getSharedPreferences("VaultCallNativePrefs", Context.MODE_PRIVATE)
        val rawContacts = prefs.getString("vault_extra_contacts", "[]") ?: "[]"
        try {
            val arr = JSONArray(rawContacts)
            for (i in 0 until arr.length()) {
                val obj = arr.optJSONObject(i) ?: continue
                if (norm(obj.optString("phone")) == target) {
                    val n = obj.optString("name", "Saved Contact")
                    val note = obj.optString("notes", "")
                    val tag = obj.optString("tag", "VaultCall DB")
                    return Triple(n, note, tag)
                }
            }
        } catch (_: Exception) {}

        return Triple("Unknown Caller", "Not found in your VaultCall database", "VaultCall DB")
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
        CallerOverlayService.show(reactCtx, number, name, notes, sourceLabel)
    }

    @ReactMethod
    fun dismissNativePopup() {
        CallerOverlayService.hide(reactCtx)
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
    callerOverlayServiceKt,
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
      fs.writeFileSync(path.join(pkgDir, "CallerOverlayService.kt"), files.callerOverlayServiceKt, "utf8");
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