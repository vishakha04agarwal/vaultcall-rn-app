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
  queuePendingTranscript, fetchContactsRemote, createContactRemote, syncPhoneContactsToDatabase,
  fetchCallLogsRemote, syncCallLogsToDatabase, fetchTranscriptsRemote, createTranscriptRemote,
  flushPendingQueue,
} from "./src/services/storage";
import {
  isNativeBridgeAvailable, requestCallAndContactsPermissions, checkOverlayPermission,
  openOverlayPermissionSettings, syncVaultExtraContactsToNative, triggerNativeCallerPopup,
  dismissNativeCallerPopup, fetchDevicePhoneContacts, fetchInternalCallLogs,
} from "./src/services/nativeBridge";

function mergeCallLogsWithRecordings(systemLogs = [], existingLogs = [], dbContacts = []) {
  const existingWithAudio = (Array.isArray(existingLogs) ? existingLogs : []).filter((e) => e && e.audioUri);
  const mapped = (Array.isArray(systemLogs) ? systemLogs : []).map((item, idx) => {
    const target = normalizePhone(item.number);
    const dbMatch = dbContacts.find((c) => normalizePhone(c.phone) === target);
    const resolvedName = dbMatch?.name || item.phoneName || "Unknown Caller";
    const audioMatch = existingWithAudio.find((old) => normalizePhone(old.number) === target && !old._used);
    if (audioMatch) audioMatch._used = true;
    return {
      id: `log_${idx}_${target || "num"}_${item.createdAt || idx}`,
      number: item.number || "Unknown",
      name: resolvedName,
      source: dbMatch?.tag || "VaultCall DB",
      notes: dbMatch?.notes || "",
      callType: item.callType || "Call",
      createdAt: item.createdAt || "",
      audioUri: audioMatch ? audioMatch.audioUri : null,
    };
  });
  return [...existingWithAudio.filter((old) => !old._used), ...mapped].slice(0, 150);
}

export default function App() {
  const [apiUrl, setApiUrlState] = useState(DEFAULT_BACKEND_URL);
  const [statusText, setStatusText] = useState("Connecting to VaultCall DB...");
  const [backendOnline, setBackendOnline] = useState(false);
  const [tab, setTab] = useState("contacts");
  const [contactFilter, setContactFilter] = useState("all");
  const [searchText, setSearchText] = useState("");
  const [profile, setProfile] = useState({ name: "Me", lang: "hi-IN" });
  const [autoRecord, setAutoRecordState] = useState(true);
  const [dbContacts, setDbContacts] = useState([]);
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
    dbContacts: [],
    callLogs: [],
    autoRecord: true,
  });

  useEffect(() => {
    stateRef.current = { apiUrl, dbContacts, callLogs, autoRecord };
  }, [apiUrl, dbContacts, callLogs, autoRecord]);

  const nativeReady = isNativeBridgeAvailable();

  const updatePendingBadge = useCallback(async () => {
    const [pc, pt] = await Promise.all([getPendingContacts(), getPendingTranscripts()]);
    if (mountedRef.current) setPendingCount(pc.length + pt.length);
  }, []);

  const syncDeviceAndDatabase = useCallback(
    async (targetUrl, currentContacts, recFlag, currentLogs) => {
      const cleanUrl = (targetUrl || stateRef.current.apiUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
      const currentRec = recFlag ?? stateRef.current.autoRecord;
      let workingContacts = currentContacts ?? stateRef.current.dbContacts;
      let workingLogs = currentLogs ?? stateRef.current.callLogs;

      const hasOverlay = await checkOverlayPermission();
      if (mountedRef.current) setOverlayGranted(hasOverlay);

      let devContacts = [];
      let devLogs = [];
      if (nativeReady) {
        try {
          devContacts = await fetchDevicePhoneContacts();
        } catch {}
        try {
          devLogs = await fetchInternalCallLogs();
        } catch {}
      }

      const health = await checkBackendHealth(cleanUrl);
      if (mountedRef.current) setBackendOnline(health.ok);

      try {
        await flushPendingQueue(cleanUrl);
        if (devContacts.length > 0) {
          await syncPhoneContactsToDatabase(cleanUrl, devContacts);
        }
        const remoteContacts = await fetchContactsRemote(cleanUrl);
        if (remoteContacts.length > 0) {
          workingContacts = remoteContacts;
          await saveCachedContacts(workingContacts);
        } else if (devContacts.length > 0) {
          workingContacts = devContacts.map((c, idx) => ({
            id: `phone_${idx}_${normalizePhone(c.phone)}`,
            name: c.name,
            phone: c.phone,
            tag: "Phone Book",
            notes: "From your phone contacts",
          }));
          await saveCachedContacts(workingContacts);
        }

        if (devLogs.length > 0) {
          workingLogs = mergeCallLogsWithRecordings(devLogs, workingLogs, workingContacts);
          await syncCallLogsToDatabase(cleanUrl, workingLogs);
          await saveCallLogs(workingLogs);
        } else {
          const remoteLogs = await fetchCallLogsRemote(cleanUrl);
          if (remoteLogs.length > 0) {
            workingLogs = remoteLogs;
            await saveCallLogs(workingLogs);
          }
        }

        const remoteT = await fetchTranscriptsRemote(cleanUrl);
        if (!mountedRef.current) return;

        setDbContacts(workingContacts);
        setCallLogs(workingLogs);
        setTranscripts(remoteT);
        setBackendOnline(true);
        await saveCachedTranscripts(remoteT);
        syncVaultExtraContactsToNative(workingContacts, currentRec);
        await updatePendingBadge();
        setStatusText(`DB Connected | ${workingContacts.length} Contacts | ${workingLogs.length} Logs`);
      } catch {
        if (devContacts.length > 0) {
          const map = new Map();
          for (const c of workingContacts) {
            map.set(`${normalizePhone(c.phone)}_${c.tag || "Vault"}`, c);
          }
          for (const dc of devContacts) {
            const k = `${normalizePhone(dc.phone)}_Phone Book`;
            if (!map.has(k)) {
              map.set(k, {
                id: `phone_${normalizePhone(dc.phone)}_${map.size}`,
                name: dc.name,
                phone: dc.phone,
                tag: "Phone Book",
                notes: "From your phone contacts",
              });
            }
          }
          workingContacts = Array.from(map.values());
          await saveCachedContacts(workingContacts);
        }
        if (devLogs.length > 0) {
          workingLogs = mergeCallLogsWithRecordings(devLogs, workingLogs, workingContacts);
          await saveCallLogs(workingLogs);
        }
        await updatePendingBadge();
        if (!mountedRef.current) return;
        setDbContacts(workingContacts);
        setCallLogs(workingLogs);
        setBackendOnline(false);
        syncVaultExtraContactsToNative(workingContacts, currentRec);
        setStatusText(`Local DB | ${workingContacts.length} Contacts | ${workingLogs.length} Logs`);
      }
    },
    [nativeReady, updatePendingBadge]
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
      setDbContacts(cachedC);
      setTranscripts(cachedT);
      setCallLogs(logs);
      if (cachedC[0]?.phone) setLookupPhone(cachedC[0].phone);
      await updatePendingBadge();
      await syncDeviceAndDatabase(url, cachedC, recFlag, logs);
    })();

    return () => {
      mountedRef.current = false;
      syncEngineRef.current?.stopAutoSync();
      Speech.stop();
      if (recordingRef.current) { recordingRef.current.stopAndUnloadAsync().catch(() => {}); recordingRef.current = null; }
      if (soundRef.current) { soundRef.current.unloadAsync().catch(() => {}); soundRef.current = null; }
    };
  }, [syncDeviceAndDatabase, updatePendingBadge]);

  const matchedCaller = useMemo(() => {
    const target = normalizePhone(lookupPhone);
    if (!target) return null;
    const extra = dbContacts.find((c) => normalizePhone(c.phone) === target && c.tag === "Extra Vault");
    if (extra) return { id: extra.id, name: extra.name, phone: extra.phone, notes: extra.notes || "", source: "Extra Vault" };
    const found = dbContacts.find((c) => normalizePhone(c.phone) === target);
    if (found) return { id: found.id, name: found.name, phone: found.phone, notes: found.notes || "From VaultCall DB", source: found.tag || "VaultCall DB" };
    return null;
  }, [dbContacts, lookupPhone]);

  const displayedContacts = useMemo(() => {
    const list = (dbContacts || []).map((c, idx) => ({
      id: String(c.id || `db_${normalizePhone(c.phone) || idx}_${idx}`),
      name: c.name || "Saved Contact",
      phone: c.phone || "",
      tag: c.tag || "VaultCall DB",
      notes: c.notes || "",
    }));

    const filteredByTag =
      contactFilter === "extra"
        ? list.filter((i) => i.tag === "Extra Vault")
        : contactFilter === "phone"
          ? list.filter((i) => i.tag === "Phone Book")
          : list;

    const q = searchText.trim().toLowerCase();
    const qDigits = normalizePhone(searchText);
    if (!q) return filteredByTag;
    return filteredByTag.filter((item) => {
      const nameMatch = (item.name || "").toLowerCase().includes(q);
      const phoneMatch = (item.phone || "").toLowerCase().includes(q) || (qDigits && normalizePhone(item.phone).includes(qDigits));
      return nameMatch || phoneMatch;
    });
  }, [dbContacts, contactFilter, searchText]);

  const handleSyncAndAllow = async () => {
    await requestCallAndContactsPermissions();
    if (nativeReady) {
      const hasOverlay = await checkOverlayPermission();
      setOverlayGranted(hasOverlay);
      if (!hasOverlay) {
        openOverlayPermissionSettings();
      }
    }
    await syncDeviceAndDatabase(apiUrl, dbContacts, autoRecord, callLogs);
  };

  const handleSaveContact = async () => {
    if (!nameInput.trim() || normalizePhone(phoneInput).length < 5) {
      Alert.alert("Validation", "Please enter a valid name and phone number.");
      return;
    }
    const payload = {
      name: nameInput.trim(),
      phone: phoneInput.trim(),
      tag: tagInput.trim() || "Extra Vault",
      notes: notesInput.trim(),
    };
    try {
      const saved = await createContactRemote(apiUrl, payload);
      const item = saved && (saved.id || saved.name) ? saved : { id: String(Date.now()), ...payload };
      const next = [item, ...dbContacts.filter((c) => c.id !== item.id)];
      setDbContacts(next);
      await saveCachedContacts(next);
      syncVaultExtraContactsToNative(next, autoRecord);
      setBackendOnline(true);
      setNameInput(""); setPhoneInput(""); setNotesInput("");
    } catch {
      const next = [{ id: String(Date.now()), ...payload }, ...dbContacts];
      setDbContacts(next);
      await saveCachedContacts(next);
      await queuePendingContact(payload);
      await updatePendingBadge();
      syncVaultExtraContactsToNative(next, autoRecord);
      setBackendOnline(false);
      setNameInput(""); setPhoneInput(""); setNotesInput("");
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
          source: matchedCaller ? matchedCaller.source : "VaultCall DB", notes: matchedCaller?.notes || "",
          callType: "Recorded Call", audioUri: uri, createdAt: new Date().toLocaleString(),
        });
        setCallLogs(nextLogs);
        return;
      }
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) return;
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true, shouldDuckAndroid: true, playThroughEarpieceAndroid: false });
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      recordingRef.current = rec; setIsRecording(true);
    } catch {
      recordingRef.current = null; setIsRecording(false);
    }
  };

  const playLastRecording = async (uriToPlay) => {
    const targetUri = uriToPlay || lastAudioUri;
    if (!targetUri) return;
    try {
      if (soundRef.current) { await soundRef.current.unloadAsync().catch(() => {}); soundRef.current = null; }
      const { sound } = await Audio.Sound.createAsync({ uri: targetUri });
      soundRef.current = sound; await sound.playAsync();
    } catch {}
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
    if (!liveLines.length) return;
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
    } catch {
      const next = [{ id: String(Date.now()), ...payload }, ...transcripts];
      setTranscripts(next); await saveCachedTranscripts(next);
      await queuePendingTranscript(payload); await updatePendingBadge();
      setBackendOnline(false);
      setLiveLines([]); setTab("transcripts");
    }
  };

  const handleSaveSettings = async () => {
    const clean = await setBackendUrl(apiUrl); setApiUrlState(clean);
    const cleanProfile = await saveProfile(profile); setProfile(cleanProfile);
    await setAutoRecord(autoRecord);
    syncVaultExtraContactsToNative(dbContacts, autoRecord);
    await syncDeviceAndDatabase(clean, dbContacts, autoRecord, callLogs);
  };

  const triggerCallerPopup = async (phoneVal) => {
    const num = (phoneVal ?? lookupPhone).trim();
    if (num) setLookupPhone(num);
    const target = normalizePhone(num);
    const match = dbContacts.find((c) => normalizePhone(c.phone) === target);

    if (nativeReady) {
      const hasOverlay = await checkOverlayPermission();
      setOverlayGranted(hasOverlay);
      if (!hasOverlay) {
        openOverlayPermissionSettings();
      } else {
        triggerNativeCallerPopup(
          num || "Unknown",
          match ? match.name : "Unknown Caller",
          match ? match.notes || "Matched in VaultCall DB" : "Not in your VaultCall DB",
          match ? match.tag || "VaultCall DB" : "VaultCall DB"
        );
      }
    }
    setPopupVisible(true);
  };

  const closeCallerPopup = () => {
    setPopupVisible(false);
    dismissNativeCallerPopup();
  };

  const callerSpeakerLabel = matchedCaller ? matchedCaller.name : lookupPhone || "Caller";

  const renderContactItem = useCallback(
    ({ item: c }) => (
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.contactName}>{c.name} ({c.tag || "VaultCall DB"})</Text>
          <TouchableOpacity style={styles.smallBtn} onPress={() => triggerCallerPopup(c.phone)}>
            <Text style={styles.smallBtnText}>Pop-up</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.phoneText}>{c.phone}</Text>
        {c.notes ? <Text style={styles.noteText}>{c.notes}</Text> : null}
      </View>
    ),
    [dbContacts, nativeReady, lookupPhone]
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
          <Text style={styles.cardTitle}>Add Contact to Your VaultCall DB</Text>
          <TextInput style={styles.input} placeholder="Name" placeholderTextColor="#64748B" value={nameInput} onChangeText={setNameInput} />
          <TextInput style={styles.input} placeholder="Phone (+91 98765 43210)" placeholderTextColor="#64748B" keyboardType="phone-pad" value={phoneInput} onChangeText={setPhoneInput} />
          <TextInput style={styles.input} placeholder="Tag" placeholderTextColor="#64748B" value={tagInput} onChangeText={setTagInput} />
          <TextInput style={[styles.input, styles.textarea]} placeholder="Notes shown in incoming call pop-up..." placeholderTextColor="#64748B" multiline value={notesInput} onChangeText={setNotesInput} />
          <TouchableOpacity style={styles.primaryBtn} onPress={handleSaveContact}><Text style={styles.btnText}>Save to VaultCall DB</Text></TouchableOpacity>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Database Caller Lookup & Pop-up</Text>
          <TextInput style={styles.input} placeholder="Enter number to search DB / show pop-up..." placeholderTextColor="#64748B" keyboardType="phone-pad" value={lookupPhone} onChangeText={setLookupPhone} />
          <View style={styles.matchBox}>
            <Text style={styles.matchTitle}>{matchedCaller ? `${matchedCaller.name} (${matchedCaller.source})` : "Unknown Caller"}</Text>
            <Text style={styles.matchSub}>{matchedCaller ? matchedCaller.notes || "Matched in VaultCall DB" : "Not found in your VaultCall DB."}</Text>
          </View>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => triggerCallerPopup(lookupPhone)}><Text style={styles.btnText}>Show Call Pop-up</Text></TouchableOpacity>
        </View>
        <View style={styles.card}>
          <TextInput
            style={styles.input}
            placeholder="Search database contacts by name or number..."
            placeholderTextColor="#64748B"
            value={searchText}
            onChangeText={setSearchText}
          />
          <View style={styles.rowGap}>
            {[
              ["all", `All (${dbContacts.length})`],
              ["extra", `Extra (${dbContacts.filter((c) => c.tag === "Extra Vault").length})`],
              ["phone", `Phone (${dbContacts.filter((c) => c.tag === "Phone Book").length})`],
            ].map(([key, label]) => (
              <TouchableOpacity
                key={key}
                style={[styles.speakerChip, contactFilter === key && styles.speakerChipActive]}
                onPress={() => setContactFilter(key)}
              >
                <Text style={styles.btnText}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>
    ),
    [nameInput, phoneInput, tagInput, notesInput, lookupPhone, matchedCaller, searchText, dbContacts, contactFilter]
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
        <Text style={styles.cardTitle}>Call Logs (Synced with VaultCall DB)</Text>
        <View style={styles.rowGap}>
          <TouchableOpacity style={styles.secondaryBtnFlex} onPress={() => syncDeviceAndDatabase(apiUrl, dbContacts, autoRecord, callLogs)}><Text style={styles.btnText}>Sync Call Logs to DB</Text></TouchableOpacity>
          <TouchableOpacity style={styles.secondaryBtnFlex} onPress={() => playLastRecording(lastAudioUri)}><Text style={styles.btnText}>Play Latest Audio</Text></TouchableOpacity>
        </View>
      </View>
    ),
    [apiUrl, dbContacts, autoRecord, callLogs, lastAudioUri]
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
          {`DB Contacts: ${dbContacts.length} | Logs: ${callLogs.length} | Overlay: ${overlayGranted ? "ON" : "OFF"}`}
        </Text>
        <TouchableOpacity style={styles.smallBtn} onPress={handleSyncAndAllow}>
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
          data={displayedContacts}
          keyExtractor={(c) => c.id}
          renderItem={renderContactItem}
          ListHeaderComponent={contactsHeader}
          ListEmptyComponent={
            <View style={styles.card}>
              <Text style={styles.matchSub}>Tap Sync & Allow to import phone contacts into VaultCall DB or add one above.</Text>
            </View>
          }
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
          ListEmptyComponent={<View style={styles.card}><Text style={styles.matchSub}>No call logs yet. Tap Sync & Allow.</Text></View>}
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
              <Text style={styles.cardTitle}>VaultCall DB & Phone Settings</Text>
              <TouchableOpacity style={styles.secondaryBtn} onPress={handleSyncAndAllow}><Text style={styles.btnText}>Sync Phone Book & Logs to DB + Permissions</Text></TouchableOpacity>
              <TouchableOpacity style={styles.secondaryBtn} onPress={() => openOverlayPermissionSettings()}><Text style={styles.btnText}>Open Display Over Other Apps Settings</Text></TouchableOpacity>
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
            <Text style={styles.modalBadge}>VAULTCALL DB POP-UP | {matchedCaller ? matchedCaller.source : "UNKNOWN"}</Text>
            <Text style={styles.modalTitle}>{matchedCaller ? matchedCaller.name : "Unknown Caller"}</Text>
            <Text style={styles.phoneText}>{lookupPhone || "No Number"}</Text>
            <Text style={styles.modalNotes}>{matchedCaller ? matchedCaller.notes || "Matched in VaultCall DB" : "Not found in your VaultCall DB."}</Text>
            <View style={styles.rowGap}>
              <TouchableOpacity style={[styles.recBtn, isRecording && styles.recBtnActive]} onPress={startAudioRecording}><Text style={styles.btnText}>{isRecording ? "Stop Recording" : "Start Recording"}</Text></TouchableOpacity>
              <TouchableOpacity style={styles.secondaryBtnFlex} onPress={closeCallerPopup}><Text style={styles.btnText}>Close</Text></TouchableOpacity>
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