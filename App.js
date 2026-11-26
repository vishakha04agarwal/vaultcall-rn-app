import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SafeAreaView, FlatList, View, Text, TextInput, TouchableOpacity, StyleSheet, Modal, Switch, Alert,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { Audio } from "expo-av";
import * as Speech from "expo-speech";
import { SECURITY_CONSTANTS } from "./src/config/security";
import { checkBackendHealth, OfflineSyncEngine } from "./src/services/syncManager";
import {
  DEFAULT_BACKEND_URL, normalizePhone, getBackendUrl, setBackendUrl, getProfile, saveProfile,
  getAutoRecord, setAutoRecord, getCachedContacts, saveCachedContacts, getCachedTranscripts,
  saveCachedTranscripts, getCallLogs, saveCallLogs, appendCallLog, getPendingContacts,
  savePendingContacts, queuePendingContact, getPendingTranscripts, savePendingTranscripts,
  queuePendingTranscript, fetchContactsRemote, createContactRemote, fetchTranscriptsRemote,
  createTranscriptRemote, flushPendingQueue,
} from "./src/services/storage";
import {
  isNativeBridgeAvailable, requestCallAndContactsPermissions, checkOverlayPermission,
  openOverlayPermissionSettings, syncVaultExtraContactsToNative, triggerNativeCallerPopup,
  fetchDevicePhoneContacts, fetchInternalCallLogs,
} from "./src/services/nativeBridge";

function mergeCallLogsWithRecordings(systemLogs = [], existingLogs = [], extraContacts = [], devContacts = []) {
  const existingWithAudio = (Array.isArray(existingLogs) ? existingLogs : []).filter((e) => e && e.audioUri);
  const mapped = (Array.isArray(systemLogs) ? systemLogs : []).map((item, idx) => {
    const target = normalizePhone(item.number);
    const extraMatch = extraContacts.find((c) => normalizePhone(c.phone) === target);
    const phoneMatch = devContacts.find((c) => normalizePhone(c.phone) === target);
    const resolvedName = extraMatch ? extraMatch.name : item.phoneName || phoneMatch?.name || "Unknown Caller";
    const audioMatch = existingWithAudio.find((old) => normalizePhone(old.number) === target && !old._used);
    if (audioMatch) audioMatch._used = true;
    return {
      id: `sys_${idx}_${target || "num"}_${item.createdAt || idx}`,
      number: item.number || "Unknown",
      name: resolvedName,
      source: extraMatch ? "Vault Extra" : phoneMatch || item.phoneName ? "Phone Book" : "Unknown",
      notes: extraMatch?.notes || (phoneMatch || item.phoneName ? "From your phone contacts" : ""),
      callType: item.callType || "Call",
      createdAt: item.createdAt || "",
      audioUri: audioMatch ? audioMatch.audioUri : null,
    };
  });
  return [...existingWithAudio.filter((old) => !old._used), ...mapped].slice(0, 150);
}

export default function App() {
  const [apiUrl, setApiUrlState] = useState(DEFAULT_BACKEND_URL);
  const [statusText, setStatusText] = useState("Connecting to VaultCall...");
  const [backendOnline, setBackendOnline] = useState(false);
  const [tab, setTab] = useState("contacts");
  const [profile, setProfile] = useState({ name: "Me", lang: "hi-IN" });
  const [autoRecord, setAutoRecordState] = useState(true);
  const [vaultExtraContacts, setVaultExtraContacts] = useState([]);
  const [phoneContacts, setPhoneContacts] = useState([]);
  const [transcripts, setTranscripts] = useState([]);
  const [callLogs, setCallLogs] = useState([]);
  const [overlayGranted, setOverlayGranted] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [nameInput, setNameInput] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [tagInput, setTagInput] = useState("Extra Vault");
  const [notesInput, setNotesInput] = useState("");
  const [lookupPhone, setLookupPhone] = useState("");
  const [popupVisible, setPopupVisible] = useState(false);
  const [speaker, setSpeaker] = useState("Me");
  const [lineText, setLineText] = useState("");
  const [liveLines, setLiveLines] = useState([]);
  const [isRecording, setIsRecording] = useState(false);
  const [lastAudioUri, setLastAudioUri] = useState(null);

  const recordingRef = useRef(null);
  const soundRef = useRef(null);
  const mountedRef = useRef(true);
  const stateRef = useRef({
    apiUrl: DEFAULT_BACKEND_URL,
    vaultExtraContacts: [],
    phoneContacts: [],
    callLogs: [],
    autoRecord: true,
  });

  useEffect(() => {
    stateRef.current = { apiUrl, vaultExtraContacts, phoneContacts, callLogs, autoRecord };
  }, [apiUrl, vaultExtraContacts, phoneContacts, callLogs, autoRecord]);

  const nativeReady = isNativeBridgeAvailable();

  const updatePendingBadge = useCallback(async () => {
    const [pc, pt] = await Promise.all([getPendingContacts(), getPendingTranscripts()]);
    if (mountedRef.current) setPendingCount(pc.length + pt.length);
  }, []);

  const refreshPhoneIntegration = useCallback(
    async (extraList, recFlag, currentLogs) => {
      const targetExtra = extraList ?? stateRef.current.vaultExtraContacts;
      const targetRec = recFlag ?? stateRef.current.autoRecord;
      const targetLogs = currentLogs ?? stateRef.current.callLogs;

      syncVaultExtraContactsToNative(targetExtra, targetRec);
      const hasOverlay = await checkOverlayPermission();
      if (mountedRef.current) setOverlayGranted(hasOverlay);
      if (!nativeReady) return targetLogs;

      let devContacts = stateRef.current.phoneContacts;
      try {
        devContacts = await fetchDevicePhoneContacts();
        if (mountedRef.current) setPhoneContacts(devContacts);
      } catch {}

      try {
        const devLogs = await fetchInternalCallLogs();
        if (devLogs.length > 0) {
          const merged = mergeCallLogsWithRecordings(devLogs, targetLogs, targetExtra, devContacts);
          await saveCallLogs(merged);
          if (mountedRef.current) setCallLogs(merged);
          return merged;
        }
      } catch {}
      return targetLogs;
    },
    [nativeReady]
  );

  const syncWithBackend = useCallback(
    async (targetUrl, extraList, recFlag) => {
      const cleanUrl = (targetUrl || stateRef.current.apiUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
      const currentExtra = extraList ?? stateRef.current.vaultExtraContacts;
      const currentRec = recFlag ?? stateRef.current.autoRecord;

      const health = await checkBackendHealth(cleanUrl);
      if (mountedRef.current) setBackendOnline(health.ok);

      try {
        const q = await flushPendingQueue(cleanUrl);
        const [remoteC, remoteT] = await Promise.all([
          fetchContactsRemote(cleanUrl),
          fetchTranscriptsRemote(cleanUrl),
        ]);
        if (!mountedRef.current) return;
        const mergedContacts = remoteC.length > 0 ? remoteC : currentExtra;
        setVaultExtraContacts(mergedContacts);
        setTranscripts(remoteT);
        setBackendOnline(true);
        await saveCachedContacts(mergedContacts);
        await saveCachedTranscripts(remoteT);
        syncVaultExtraContactsToNative(mergedContacts, currentRec);
        await updatePendingBadge();
        const note = q.syncedContactsCount + q.syncedTranscriptsCount > 0 ? " (Queued synced)" : "";
        setStatusText(`Online | ${mergedContacts.length} Extra + Phone${note}`);
      } catch {
        await updatePendingBadge();
        if (mountedRef.current) {
          setBackendOnline(false);
          setStatusText(`Offline / Local Vault | ${health.message}`);
        }
      }
    },
    [updatePendingBadge]
  );

  const syncEngineRef = useRef(null);
  if (!syncEngineRef.current) {
    syncEngineRef.current = new OfflineSyncEngine({
      readQueue: async () => {
        const [pc, pt] = await Promise.all([getPendingContacts(), getPendingTranscripts()]);
        return [
          ...pc.map((item) => ({ _kind: "contact", payload: item })),
          ...pt.map((item) => ({ _kind: "transcript", payload: item })),
        ];
      },
      writeQueue: async (entries) => {
        const contacts = entries.filter((e) => e._kind === "contact").map((e) => e.payload);
        const transcriptsList = entries.filter((e) => e._kind === "transcript").map((e) => e.payload);
        await Promise.all([savePendingContacts(contacts), savePendingTranscripts(transcriptsList)]);
      },
      pushItem: async (entry) => {
        const url = stateRef.current.apiUrl || DEFAULT_BACKEND_URL;
        if (entry._kind === "contact") {
          await createContactRemote(url, entry.payload);
        } else {
          await createTranscriptRemote(url, entry.payload);
        }
      },
      onStateChange: ({ pendingCount: nextPending }) => {
        if (mountedRef.current) setPendingCount(nextPending);
      },
    });
  }

  useEffect(() => {
    mountedRef.current = true;
    syncEngineRef.current.startAutoSync(SECURITY_CONSTANTS.SYNC_INTERVAL_MS);

    (async () => {
      const [url, prof, recFlag, cachedC, cachedT, logs] = await Promise.all([
        getBackendUrl(), getProfile(), getAutoRecord(), getCachedContacts(), getCachedTranscripts(), getCallLogs(),
      ]);
      if (!mountedRef.current) return;
      setApiUrlState(url);
      setProfile(prof);
      setAutoRecordState(recFlag);
      setVaultExtraContacts(cachedC);
      setTranscripts(cachedT);
      setCallLogs(logs);
      if (cachedC[0]?.phone) setLookupPhone(cachedC[0].phone);
      await updatePendingBadge();
      await refreshPhoneIntegration(cachedC, recFlag, logs);
      await syncWithBackend(url, cachedC, recFlag);
    })();

    return () => {
      mountedRef.current = false;
      syncEngineRef.current?.stopAutoSync();
      Speech.stop();
      if (recordingRef.current) { recordingRef.current.stopAndUnloadAsync().catch(() => {}); recordingRef.current = null; }
      if (soundRef.current) { soundRef.current.unloadAsync().catch(() => {}); soundRef.current = null; }
    };
  }, [refreshPhoneIntegration, syncWithBackend, updatePendingBadge]);

  const matchedCaller = useMemo(() => {
    const target = normalizePhone(lookupPhone);
    if (!target) return null;
    const extra = vaultExtraContacts.find((c) => normalizePhone(c.phone) === target);
    if (extra) return { id: extra.id, name: extra.name, phone: extra.phone, notes: extra.notes || "", source: "Vault Extra" };
    const dev = phoneContacts.find((c) => normalizePhone(c.phone) === target);
    if (dev) return { id: `phone_${target}`, name: dev.name, phone: dev.phone, notes: "From your phone contacts", source: "Phone Book" };
    return null;
  }, [vaultExtraContacts, phoneContacts, lookupPhone]);

  const handleEnablePhoneIntegration = async () => {
    await requestCallAndContactsPermissions();
    const hasOverlay = await checkOverlayPermission();
    setOverlayGranted(hasOverlay);
    await refreshPhoneIntegration(vaultExtraContacts, autoRecord, callLogs);
    await syncWithBackend(apiUrl, vaultExtraContacts, autoRecord);
    if (!hasOverlay) {
      Alert.alert("Overlay Permission Needed", "Allow 'Display over other apps' for incoming call pop-up.", [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => openOverlayPermissionSettings() },
      ]);
    } else {
      Alert.alert("Integrated", "Phone contacts, call log aur caller pop-up sync ho gaye hain.");
    }
  };

  const handleSaveContact = async () => {
    if (!nameInput.trim() || normalizePhone(phoneInput).length < 6) {
      Alert.alert("Validation", "Please enter a valid name and phone number.");
      return;
    }
    const payload = { name: nameInput.trim(), phone: phoneInput.trim(), tag: tagInput.trim() || "Extra Vault", notes: notesInput.trim() };
    try {
      const saved = await createContactRemote(apiUrl, payload);
      const item = saved && (saved.id || saved.name) ? saved : { id: String(Date.now()), ...payload };
      const next = [item, ...vaultExtraContacts.filter((c) => c.id !== item.id)];
      setVaultExtraContacts(next); await saveCachedContacts(next);
      syncVaultExtraContactsToNative(next, autoRecord);
      setBackendOnline(true);
      setNameInput(""); setPhoneInput(""); setNotesInput("");
      Alert.alert("Saved", "Extra contact saved and synced.");
    } catch {
      const next = [{ id: String(Date.now()), ...payload }, ...vaultExtraContacts];
      setVaultExtraContacts(next); await saveCachedContacts(next);
      await queuePendingContact(payload); await updatePendingBadge();
      syncVaultExtraContactsToNative(next, autoRecord);
      setBackendOnline(false);
      setNameInput(""); setPhoneInput(""); setNotesInput("");
      Alert.alert("Saved Locally", "Saved in VaultCall and queued for sync.");
    }
  };

  const startAudioRecording = async () => {
    try {
      if (isRecording && recordingRef.current) {
        const active = recordingRef.current; recordingRef.current = null;
        await active.stopAndUnloadAsync();
        const uri = active.getURI();
        setIsRecording(false); setLastAudioUri(uri);
        const nextLogs = await appendCallLog({
          id: String(Date.now()), number: lookupPhone || "Unknown",
          name: matchedCaller ? matchedCaller.name : "Unknown Caller",
          source: matchedCaller ? matchedCaller.source : "Unknown", notes: matchedCaller?.notes || "",
          callType: "Recorded Call", audioUri: uri, createdAt: new Date().toLocaleString(),
        });
        setCallLogs(nextLogs);
        Alert.alert("Recording Saved", "Audio recording added to Call Logs.");
        return;
      }
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) { Alert.alert("Permission Needed", "Microphone permission is required."); return; }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true, shouldDuckAndroid: true, playThroughEarpieceAndroid: false });
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      recordingRef.current = rec; setIsRecording(true);
    } catch (err) {
      recordingRef.current = null; setIsRecording(false);
      Alert.alert("Recording Error", err?.message || "Could not start recording.");
    }
  };

  const playLastRecording = async (uriToPlay) => {
    const targetUri = uriToPlay || lastAudioUri;
    if (!targetUri) { Alert.alert("No Audio", "No recorded audio file available yet."); return; }
    try {
      if (soundRef.current) { await soundRef.current.unloadAsync().catch(() => {}); soundRef.current = null; }
      const { sound } = await Audio.Sound.createAsync({ uri: targetUri });
      soundRef.current = sound; await sound.playAsync();
    } catch { Alert.alert("Playback Error", "Unable to play this recording file."); }
  };

  const addTranscriptLine = () => {
    if (!lineText.trim()) return;
    setLiveLines((prev) => [...prev, { speaker, text: lineText.trim() }]);
    setLineText("");
  };

  const speakLine = (spk, text) => {
    const who = spk === "Me" ? profile.name || "Me" : spk;
    const prefix = profile.lang === "hi-IN" ? `${who} bol rahe hain: ` : `${who} says: `;
    Speech.stop(); Speech.speak(`${prefix}${text}`, { language: profile.lang || "hi-IN" });
  };

  const saveTranscriptToVault = async () => {
    if (!liveLines.length) { Alert.alert("Empty", "Add at least one conversation line first."); return; }
    const payload = {
      contactId: matchedCaller?.id || null,
      contactName: matchedCaller ? matchedCaller.name : lookupPhone || "Unknown Caller",
      phone: lookupPhone, duration: "01:00", consentEnabled: true, lines: liveLines,
    };
    try {
      const saved = await createTranscriptRemote(apiUrl, payload);
      const item = saved && (saved.id || saved.lines) ? saved : { id: String(Date.now()), ...payload };
      const next = [item, ...transcripts];
      setTranscripts(next); await saveCachedTranscripts(next);
      setBackendOnline(true);
      setLiveLines([]); setTab("transcripts");
      Alert.alert("Saved", "Transcript saved and synced.");
    } catch {
      const next = [{ id: String(Date.now()), ...payload }, ...transcripts];
      setTranscripts(next); await saveCachedTranscripts(next);
      await queuePendingTranscript(payload); await updatePendingBadge();
      setBackendOnline(false);
      setLiveLines([]); setTab("transcripts");
      Alert.alert("Saved Locally", "Saved locally and queued for sync.");
    }
  };

  const handleSaveSettings = async () => {
    const clean = await setBackendUrl(apiUrl); setApiUrlState(clean);
    const cleanProfile = await saveProfile(profile); setProfile(cleanProfile);
    await setAutoRecord(autoRecord);
    syncVaultExtraContactsToNative(vaultExtraContacts, autoRecord);
    await syncWithBackend(clean, vaultExtraContacts, autoRecord);
    Alert.alert("Updated", "Settings saved.");
  };

  const triggerCallerPopup = async (phoneVal) => {
    const num = (phoneVal ?? lookupPhone).trim();
    setLookupPhone(num);
    const target = normalizePhone(num);
    const extra = vaultExtraContacts.find((c) => normalizePhone(c.phone) === target);
    const dev = phoneContacts.find((c) => normalizePhone(c.phone) === target);
    const match = extra ? { name: extra.name, notes: extra.notes || "", source: "Vault Extra" } : dev ? { name: dev.name, notes: "From your phone contacts", source: "Phone Book" } : null;
    if (nativeReady) {
      const hasOverlay = await checkOverlayPermission();
      if (!hasOverlay) openOverlayPermissionSettings();
      else triggerNativeCallerPopup(num, match ? match.name : "Unknown Caller", match ? match.notes : "Not in Vault or Phone Contacts", match ? match.source : "Unknown");
    }
    setPopupVisible(true);
  };

  const callerSpeakerLabel = matchedCaller ? matchedCaller.name : lookupPhone || "Caller";

  const renderContactItem = useCallback(
    ({ item: c, index }) => (
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.contactName}>{c.name} (Vault Extra)</Text>
          <TouchableOpacity style={styles.smallBtn} onPress={() => triggerCallerPopup(c.phone)}>
            <Text style={styles.smallBtnText}>Pop-up</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.phoneText}>{c.phone}</Text>
        {c.notes ? <Text style={styles.noteText}>{c.notes}</Text> : null}
      </View>
    ),
    [vaultExtraContacts, phoneContacts, nativeReady, lookupPhone]
  );

  const renderTranscriptItem = useCallback(
    ({ item: tx }) => (
      <View style={styles.card}>
        <Text style={styles.contactName}>{tx.contact_name || tx.contactName || "Unknown Caller"} ({tx.phone || "Unknown"})</Text>
        {(tx.lines || []).map((l, i) => (
          <View key={`${l.speaker}_${i}`} style={styles.lineRow}>
            <Text style={styles.lineText}><Text style={styles.bold}>{l.speaker}: </Text>{l.text}</Text>
            <TouchableOpacity style={styles.smallBtn} onPress={() => speakLine(l.speaker, l.text)}>
              <Text style={styles.smallBtnText}>Listen</Text>
            </TouchableOpacity>
          </View>
        ))}
      </View>
    ),
    [profile]
  );

  const renderLogItem = useCallback(
    ({ item: log }) => (
      <View style={styles.card}>
        <Text style={styles.contactName}>{log.name} ({log.number})</Text>
        <Text style={styles.phoneText}>{log.callType || "Call"} | {log.createdAt}</Text>
        {log.notes ? <Text style={styles.noteText}>{log.notes}</Text> : null}
        {log.audioUri ? (
          <TouchableOpacity style={styles.smallBtn} onPress={() => playLastRecording(log.audioUri)}>
            <Text style={styles.smallBtnText}>Play Audio</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    ),
    [lastAudioUri]
  );

  const contactsHeader = useMemo(
    () => (
      <View style={styles.stack}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Add Extra Vault Contact (Not in Phone List)</Text>
          <TextInput style={styles.input} placeholder="Name" placeholderTextColor="#64748B" value={nameInput} onChangeText={setNameInput} />
          <TextInput style={styles.input} placeholder="Phone (+91 98765 43210)" placeholderTextColor="#64748B" keyboardType="phone-pad" value={phoneInput} onChangeText={setPhoneInput} />
          <TextInput style={styles.input} placeholder="Tag" placeholderTextColor="#64748B" value={tagInput} onChangeText={setTagInput} />
          <TextInput style={[styles.input, styles.textarea]} placeholder="Notes shown in incoming call pop-up..." placeholderTextColor="#64748B" multiline value={notesInput} onChangeText={setNotesInput} />
          <TouchableOpacity style={styles.primaryBtn} onPress={handleSaveContact}><Text style={styles.btnText}>Save Extra Contact</Text></TouchableOpacity>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Caller Lookup (Vault Extra + Your Phone Book)</Text>
          <TextInput style={styles.input} placeholder="Enter number to test lookup..." placeholderTextColor="#64748B" keyboardType="phone-pad" value={lookupPhone} onChangeText={setLookupPhone} />
          <View style={styles.matchBox}>
            <Text style={styles.matchTitle}>{matchedCaller ? `${matchedCaller.name} (${matchedCaller.source})` : "Unknown Caller"}</Text>
            <Text style={styles.matchSub}>{matchedCaller ? matchedCaller.notes || "Saved contact" : "Not found in your phone or Vault extra contacts."}</Text>
          </View>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => triggerCallerPopup(lookupPhone)}><Text style={styles.btnText}>Show Call Pop-up</Text></TouchableOpacity>
        </View>
      </View>
    ),
    [nameInput, phoneInput, tagInput, notesInput, lookupPhone, matchedCaller]
  );

  const transcriptsHeader = useMemo(
    () => (
      <View style={[styles.card, { marginBottom: 14 }]}>
        <Text style={styles.cardTitle}>Conversation Recording & Transcript</Text>
        <TextInput style={styles.input} placeholder="Caller Phone" placeholderTextColor="#64748B" keyboardType="phone-pad" value={lookupPhone} onChangeText={setLookupPhone} />
        <View style={styles.rowGap}>
          <TouchableOpacity style={[styles.speakerChip, speaker === "Me" && styles.speakerChipActive]} onPress={() => setSpeaker("Me")}><Text style={styles.btnText}>{profile.name || "Me"}</Text></TouchableOpacity>
          <TouchableOpacity style={[styles.speakerChip, speaker !== "Me" && styles.speakerChipActive]} onPress={() => setSpeaker(callerSpeakerLabel)}><Text style={styles.btnText}>{callerSpeakerLabel}</Text></TouchableOpacity>
        </View>
        <TextInput style={styles.input} placeholder="Type conversation line..." placeholderTextColor="#64748B" value={lineText} onChangeText={setLineText} />
        <View style={styles.rowGap}>
          <TouchableOpacity style={styles.secondaryBtnFlex} onPress={addTranscriptLine}><Text style={styles.btnText}>Add Line</Text></TouchableOpacity>
          <TouchableOpacity style={[styles.recBtn, isRecording && styles.recBtnActive]} onPress={startAudioRecording}><Text style={styles.btnText}>{isRecording ? "Stop Audio" : "Record Audio"}</Text></TouchableOpacity>
        </View>
        {liveLines.map((l, idx) => (
          <View key={`${l.speaker}_${idx}`} style={styles.lineRow}>
            <Text style={styles.lineText}><Text style={styles.bold}>{l.speaker}: </Text>{l.text}</Text>
            <TouchableOpacity style={styles.smallBtn} onPress={() => speakLine(l.speaker, l.text)}><Text style={styles.smallBtnText}>Speak</Text></TouchableOpacity>
          </View>
        ))}
        <TouchableOpacity style={styles.successBtn} onPress={saveTranscriptToVault}><Text style={styles.btnText}>Save Transcript</Text></TouchableOpacity>
      </View>
    ),
    [lookupPhone, speaker, profile.name, callerSpeakerLabel, lineText, isRecording, liveLines]
  );

  const logsHeader = useMemo(
    () => (
      <View style={[styles.card, { marginBottom: 14 }]}>
        <Text style={styles.cardTitle}>Phone Call History & Recordings</Text>
        <View style={styles.rowGap}>
          <TouchableOpacity style={styles.secondaryBtnFlex} onPress={() => refreshPhoneIntegration(vaultExtraContacts, autoRecord, callLogs)}><Text style={styles.btnText}>Refresh Phone Logs</Text></TouchableOpacity>
          <TouchableOpacity style={styles.secondaryBtnFlex} onPress={() => playLastRecording(lastAudioUri)}><Text style={styles.btnText}>Play Latest Audio</Text></TouchableOpacity>
        </View>
      </View>
    ),
    [vaultExtraContacts, autoRecord, callLogs, lastAudioUri]
  );

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>VaultCall</Text>
          <Text style={[styles.status, !backendOnline && styles.statusOffline]}>
            {statusText}{pendingCount > 0 ? ` | Pending: ${pendingCount}` : ""}
          </Text>
        </View>
        <TouchableOpacity style={styles.popupTriggerBtn} onPress={() => triggerCallerPopup(lookupPhone)}>
          <Text style={styles.popupTriggerText}>Test Pop-up</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.permBanner}>
        <Text style={styles.permText}>
          {nativeReady ? `Phone Contacts: ${phoneContacts.length} | Overlay: ${overlayGranted ? "ON" : "OFF"}` : "Expo Go Preview (Build standalone APK for native call pop-up & call log)"}
        </Text>
        <TouchableOpacity style={styles.smallBtn} onPress={handleEnablePhoneIntegration}>
          <Text style={styles.smallBtnText}>Sync & Allow</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.tabBar}>
        {[["contacts", "Contacts"], ["transcripts", "Transcripts"], ["logs", "Call Logs"], ["settings", "Settings"]].map(([k, lbl]) => (
          <TouchableOpacity key={k} style={[styles.tabBtn, tab === k && styles.tabBtnActive]} onPress={() => setTab(k)}>
            <Text style={[styles.tabText, tab === k && styles.tabTextActive]}>{lbl}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === "contacts" && (
        <FlatList
          data={vaultExtraContacts}
          keyExtractor={(c, index) => String(c.id || `${c.phone}_${index}`)}
          renderItem={renderContactItem}
          ListHeaderComponent={contactsHeader}
          contentContainerStyle={styles.content}
          ItemSeparatorComponent={() => <View style={{ height: 14 }} />}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={5}
          removeClippedSubviews
        />
      )}

      {tab === "transcripts" && (
        <FlatList
          data={transcripts}
          keyExtractor={(tx, txIdx) => String(tx.id || `tx_${txIdx}`)}
          renderItem={renderTranscriptItem}
          ListHeaderComponent={transcriptsHeader}
          contentContainerStyle={styles.content}
          ItemSeparatorComponent={() => <View style={{ height: 14 }} />}
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={5}
          removeClippedSubviews
        />
      )}

      {tab === "logs" && (
        <FlatList
          data={callLogs}
          keyExtractor={(log, logIdx) => String(log.id || `log_${logIdx}`)}
          renderItem={renderLogItem}
          ListHeaderComponent={logsHeader}
          ListEmptyComponent={<View style={styles.card}><Text style={styles.matchSub}>No call logs found yet. Tap Sync & Allow.</Text></View>}
          contentContainerStyle={styles.content}
          ItemSeparatorComponent={() => <View style={{ height: 14 }} />}
          initialNumToRender={15}
          maxToRenderPerBatch={15}
          windowSize={5}
          removeClippedSubviews
        />
      )}

      {tab === "settings" && (
        <FlatList
          data={[{ key: "settings-form" }]}
          keyExtractor={(item) => item.key}
          contentContainerStyle={styles.content}
          renderItem={() => (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Phone Integration & Backend Settings</Text>
              <TouchableOpacity style={styles.secondaryBtn} onPress={handleEnablePhoneIntegration}><Text style={styles.btnText}>Grant Call, Contacts & Overlay Permissions</Text></TouchableOpacity>
              <Text style={styles.label}>Backend URL</Text>
              <TextInput style={styles.input} value={apiUrl} onChangeText={setApiUrlState} placeholder="https://vault-backend-t9nu.onrender.com" placeholderTextColor="#64748B" />
              <Text style={styles.label}>Your Speaker Name</Text>
              <TextInput style={styles.input} value={profile.name} onChangeText={(name) => setProfile({ ...profile, name })} placeholder="Me" placeholderTextColor="#64748B" />
              <View style={styles.switchRow}><Text style={styles.lineText}>Auto-record on incoming call</Text><Switch value={autoRecord} onValueChange={setAutoRecordState} /></View>
              <TouchableOpacity style={styles.primaryBtn} onPress={handleSaveSettings}><Text style={styles.btnText}>Save Settings</Text></TouchableOpacity>
            </View>
          )}
        />
      )}

      <Modal visible={popupVisible} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalBadge}>VAULTCALL POP-UP | {matchedCaller ? matchedCaller.source : "UNKNOWN"}</Text>
            <Text style={styles.modalTitle}>{matchedCaller ? matchedCaller.name : "Unknown Caller"}</Text>
            <Text style={styles.phoneText}>{lookupPhone || "No Number"}</Text>
            <Text style={styles.modalNotes}>{matchedCaller ? matchedCaller.notes || "Saved contact" : "Not in your phone or Vault extra contacts."}</Text>
            <View style={styles.rowGap}>
              <TouchableOpacity style={[styles.recBtn, isRecording && styles.recBtnActive]} onPress={startAudioRecording}><Text style={styles.btnText}>{isRecording ? "Stop Recording" : "Start Recording"}</Text></TouchableOpacity>
              <TouchableOpacity style={styles.secondaryBtnFlex} onPress={() => setPopupVisible(false)}><Text style={styles.btnText}>Close</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#020617" },
  header: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#1E293B", flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  title: { color: "#F8FAFC", fontSize: 22, fontWeight: "700" },
  status: { color: "#6EE7B7", fontSize: 12, marginTop: 2 },
  statusOffline: { color: "#FBBF24" },
  permBanner: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: "#0F172A", borderBottomWidth: 1, borderBottomColor: "#1E293B", flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  permText: { flex: 1, color: "#CBD5E1", fontSize: 12 },
  popupTriggerBtn: { backgroundColor: "#4F46E5", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
  popupTriggerText: { color: "#FFFFFF", fontWeight: "700", fontSize: 12 },
  tabBar: { flexDirection: "row", paddingHorizontal: 12, paddingVertical: 8, gap: 6, borderBottomWidth: 1, borderBottomColor: "#1E293B" },
  tabBtn: { flex: 1, paddingVertical: 8, borderRadius: 10, backgroundColor: "#0F172A", alignItems: "center" },
  tabBtnActive: { backgroundColor: "#4F46E5" },
  tabText: { color: "#94A3B8", fontSize: 12, fontWeight: "600" },
  tabTextActive: { color: "#FFFFFF" },
  content: { padding: 16 },
  stack: { gap: 14, marginBottom: 14 },
  card: { backgroundColor: "#0F172A", borderRadius: 14, borderWidth: 1, borderColor: "#1E293B", padding: 14, gap: 10 },
  cardTitle: { color: "#F8FAFC", fontSize: 16, fontWeight: "700" },
  label: { color: "#94A3B8", fontSize: 12, fontWeight: "600" },
  input: { backgroundColor: "#020617", color: "#F1F5F9", borderWidth: 1, borderColor: "#1E293B", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  textarea: { minHeight: 70, textAlignVertical: "top" },
  primaryBtn: { backgroundColor: "#4F46E5", paddingVertical: 12, borderRadius: 10, alignItems: "center" },
  secondaryBtn: { backgroundColor: "#1E293B", paddingVertical: 11, borderRadius: 10, alignItems: "center" },
  secondaryBtnFlex: { flex: 1, backgroundColor: "#1E293B", paddingVertical: 11, borderRadius: 10, alignItems: "center" },
  successBtn: { backgroundColor: "#059669", paddingVertical: 12, borderRadius: 10, alignItems: "center" },
  recBtn: { flex: 1, backgroundColor: "#0D9488", paddingVertical: 11, borderRadius: 10, alignItems: "center" },
  recBtnActive: { backgroundColor: "#DC2626" },
  btnText: { color: "#FFFFFF", fontWeight: "700", fontSize: 13 },
  matchBox: { backgroundColor: "#020617", borderRadius: 10, padding: 10, gap: 4 },
  matchTitle: { color: "#6EE7B7", fontSize: 15, fontWeight: "700" },
  matchSub: { color: "#CBD5E1", fontSize: 13 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rowGap: { flexDirection: "row", gap: 8, alignItems: "center" },
  contactName: { color: "#F8FAFC", fontSize: 16, fontWeight: "700" },
  phoneText: { color: "#93C5FD", fontSize: 13 },
  noteText: { color: "#CBD5E1", fontSize: 13 },
  smallBtn: { backgroundColor: "#1E293B", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  smallBtnText: { color: "#6EE7B7", fontSize: 12, fontWeight: "700" },
  speakerChip: { flex: 1, backgroundColor: "#020617", borderWidth: 1, borderColor: "#334155", paddingVertical: 8, borderRadius: 8, alignItems: "center" },
  speakerChipActive: { backgroundColor: "#4F46E5", borderColor: "#4F46E5" },
  lineRow: { backgroundColor: "#020617", padding: 10, borderRadius: 10, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  lineText: { flex: 1, color: "#F1F5F9", fontSize: 13 },
  bold: { fontWeight: "700", color: "#93C5FD" },
  switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(2, 6, 23, 0.82)", justifyContent: "center", padding: 20 },
  modalCard: { backgroundColor: "#0F172A", borderRadius: 16, borderWidth: 1, borderColor: "#4F46E5", padding: 18, gap: 10 },
  modalBadge: { color: "#A5B4FC", fontSize: 11, fontWeight: "700" },
  modalTitle: { color: "#F8FAFC", fontSize: 20, fontWeight: "700" },
  modalNotes: { color: "#D1FAE5", fontSize: 14, backgroundColor: "#020617", padding: 10, borderRadius: 10 },
});