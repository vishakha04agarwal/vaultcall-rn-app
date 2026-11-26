import React, { useEffect, useMemo, useState } from "react";
import {
  SafeAreaView,
  ScrollView,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Switch,
  Alert,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { Audio } from "expo-av";
import * as Speech from "expo-speech";
import {
  DEFAULT_BACKEND_URL,
  normalizePhone,
  getBackendUrl,
  setBackendUrl,
  getProfile,
  saveProfile,
  getAutoRecord,
  setAutoRecord,
  getCachedContacts,
  saveCachedContacts,
  getCachedTranscripts,
  saveCachedTranscripts,
  getCallLogs,
  appendCallLog,
  fetchContactsRemote,
  createContactRemote,
  fetchTranscriptsRemote,
  createTranscriptRemote,
} from "./src/services/storage";

export default function App() {
  const [apiUrl, setApiUrlState] = useState(DEFAULT_BACKEND_URL);
  const [statusText, setStatusText] = useState("Connecting to VaultCall backend...");
  const [tab, setTab] = useState("contacts");

  const [profile, setProfile] = useState({ name: "Me", lang: "hi-IN" });
  const [autoRecord, setAutoRecordState] = useState(false);

  const [contacts, setContacts] = useState([]);
  const [transcripts, setTranscripts] = useState([]);
  const [callLogs, setCallLogs] = useState([]);

  const [nameInput, setNameInput] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [tagInput, setTagInput] = useState("Vault");
  const [notesInput, setNotesInput] = useState("");

  const [lookupPhone, setLookupPhone] = useState("");
  const [popupVisible, setPopupVisible] = useState(false);

  const [speaker, setSpeaker] = useState("Me");
  const [lineText, setLineText] = useState("");
  const [liveLines, setLiveLines] = useState([]);

  const [recording, setRecording] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [lastAudioUri, setLastAudioUri] = useState(null);
  const [soundObj, setSoundObj] = useState(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const url = await getBackendUrl();
      const prof = await getProfile();
      const recFlag = await getAutoRecord();
      const cachedC = await getCachedContacts();
      const cachedT = await getCachedTranscripts();
      const logs = await getCallLogs();

      if (!mounted) return;
      setApiUrlState(url);
      setProfile(prof);
      setAutoRecordState(recFlag);
      setContacts(cachedC);
      setTranscripts(cachedT);
      setCallLogs(logs);
      if (cachedC[0]?.phone) setLookupPhone(cachedC[0].phone);

      try {
        const [remoteC, remoteT] = await Promise.all([
          fetchContactsRemote(url),
          fetchTranscriptsRemote(url),
        ]);
        if (!mounted) return;
        setContacts(remoteC);
        setTranscripts(remoteT);
        await saveCachedContacts(remoteC);
        await saveCachedTranscripts(remoteT);
        if (remoteC[0]?.phone) setLookupPhone(remoteC[0].phone);
        setStatusText(`Synced (${remoteC.length} contacts) • Neon DB`);
      } catch {
        if (mounted) setStatusText("Local Vault Cache Active (Offline / Sleeping API)");
      }
    })();

    return () => {
      mounted = false;
      if (soundObj) {
        soundObj.unloadAsync().catch(() => {});
      }
    };
  }, []);

  const matchedContact = useMemo(() => {
    const target = normalizePhone(lookupPhone);
    if (!target) return null;
    return contacts.find((c) => normalizePhone(c.phone) === target) || null;
  }, [contacts, lookupPhone]);

  const handleSaveContact = async () => {
    if (!nameInput.trim() || normalizePhone(phoneInput).length < 6) {
      Alert.alert("Validation", "Please enter a valid name and phone number.");
      return;
    }

    const payload = {
      name: nameInput.trim(),
      phone: phoneInput.trim(),
      tag: tagInput.trim() || "Vault",
      notes: notesInput.trim(),
    };

    try {
      const saved = await createContactRemote(apiUrl, payload);
      const next = [saved, ...contacts.filter((c) => c.id !== saved.id)];
      setContacts(next);
      await saveCachedContacts(next);
      setNameInput("");
      setPhoneInput("");
      setNotesInput("");
      setStatusText("Saved to VaultCall Backend");
      Alert.alert("Saved", "Contact saved in VaultCall (separate from phone book).");
    } catch {
      const localItem = { id: String(Date.now()), ...payload };
      const next = [localItem, ...contacts];
      setContacts(next);
      await saveCachedContacts(next);
      setNameInput("");
      setPhoneInput("");
      setNotesInput("");
      Alert.alert("Saved Locally", "Saved on device; will sync when backend responds.");
    }
  };

  const startAudioRecording = async () => {
    try {
      if (isRecording && recording) {
        await recording.stopAndUnloadAsync();
        const uri = recording.getURI();
        setRecording(null);
        setIsRecording(false);
        setLastAudioUri(uri);

        const nextLogs = await appendCallLog({
          id: String(Date.now()),
          number: lookupPhone || "Unknown",
          name: matchedContact ? matchedContact.name : "Unknown Caller",
          notes: matchedContact?.notes || "",
          audioUri: uri,
          createdAt: new Date().toLocaleString(),
        });
        setCallLogs(nextLogs);
        Alert.alert("Recording Saved", "Audio recording added to Call Logs.");
        return;
      }

      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission Needed", "Microphone permission is required to record audio.");
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      setRecording(rec);
      setIsRecording(true);
    } catch (err) {
      Alert.alert("Recording Error", err.message || "Could not start recording.");
    }
  };

  const playLastRecording = async (uriToPlay) => {
    const targetUri = uriToPlay || lastAudioUri;
    if (!targetUri) {
      Alert.alert("No Audio", "No recorded audio file available yet.");
      return;
    }
    try {
      if (soundObj) {
        await soundObj.unloadAsync();
      }
      const { sound } = await Audio.Sound.createAsync({ uri: targetUri });
      setSoundObj(sound);
      await sound.playAsync();
    } catch {
      Alert.alert("Playback Error", "Unable to play this recording file.");
    }
  };

  const addTranscriptLine = () => {
    if (!lineText.trim()) return;
    setLiveLines((prev) => [...prev, { speaker, text: lineText.trim() }]);
    setLineText("");
  };

  const speakLine = (spk, text) => {
    const who = spk === "Me" ? profile.name || "Me" : spk;
    const prefix = profile.lang === "hi-IN" ? `${who} बोल रहे हैं: ` : `${who} says: `;
    Speech.stop();
    Speech.speak(`${prefix}${text}`, {
      language: profile.lang || "hi-IN",
    });
  };

  const saveTranscriptToVault = async () => {
    if (liveLines.length === 0) {
      Alert.alert("Empty", "Add at least one conversation line first.");
      return;
    }
    const payload = {
      contactId: matchedContact?.id || null,
      contactName: matchedContact ? matchedContact.name : lookupPhone || "Unknown Caller",
      phone: lookupPhone,
      duration: "01:00",
      consentEnabled: true,
      lines: liveLines,
    };

    try {
      const saved = await createTranscriptRemote(apiUrl, payload);
      const next = [saved, ...transcripts];
      setTranscripts(next);
      await saveCachedTranscripts(next);
      setLiveLines([]);
      setTab("transcripts");
      Alert.alert("Saved", "Transcript saved to VaultCall database.");
    } catch {
      const localTx = { id: String(Date.now()), ...payload };
      const next = [localTx, ...transcripts];
      setTranscripts(next);
      await saveCachedTranscripts(next);
      setLiveLines([]);
      setTab("transcripts");
      Alert.alert("Saved Locally", "Transcript stored in local vault.");
    }
  };

  const handleSaveSettings = async () => {
    const clean = await setBackendUrl(apiUrl);
    setApiUrlState(clean);
    await saveProfile(profile);
    await setAutoRecord(autoRecord);
    Alert.alert("Updated", "Backend URL and preferences saved.");
  };

  const triggerCallerPopup = async (phoneVal) => {
    const num = (phoneVal ?? lookupPhone).trim();
    setLookupPhone(num);
    setPopupVisible(true);
    const match = contacts.find((c) => normalizePhone(c.phone) === normalizePhone(num));
    const nextLogs = await appendCallLog({
      id: String(Date.now()),
      number: num || "Unknown",
      name: match ? match.name : "Unknown Caller",
      notes: match?.notes || "",
      audioUri: null,
      createdAt: new Date().toLocaleString(),
    });
    setCallLogs(nextLogs);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>VaultCall</Text>
          <Text style={styles.status}>{statusText}</Text>
        </View>
        <TouchableOpacity
          style={styles.popupTriggerBtn}
          onPress={() => triggerCallerPopup(lookupPhone)}
        >
          <Text style={styles.popupTriggerText}>Caller Pop-up</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.tabBar}>
        {[
          ["contacts", "Contacts"],
          ["transcripts", "Transcripts"],
          ["logs", "Call Logs"],
          ["settings", "Settings"],
        ].map(([key, label]) => (
          <TouchableOpacity
            key={key}
            style={[styles.tabBtn, tab === key && styles.tabBtnActive]}
            onPress={() => setTab(key)}
          >
            <Text style={[styles.tabText, tab === key && styles.tabTextActive]}>
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {tab === "contacts" && (
          <View style={styles.stack}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Private Vault Contact (Not in Phone Book)</Text>
              <TextInput
                style={styles.input}
                placeholder="Name (e.g., Rahul Sharma)"
                placeholderTextColor="#64748B"
                value={nameInput}
                onChangeText={setNameInput}
              />
              <TextInput
                style={styles.input}
                placeholder="Phone (+91 98765 43210)"
                placeholderTextColor="#64748B"
                keyboardType="phone-pad"
                value={phoneInput}
                onChangeText={setPhoneInput}
              />
              <TextInput
                style={styles.input}
                placeholder="Tag (Client / Temp / Vendor)"
                placeholderTextColor="#64748B"
                value={tagInput}
                onChangeText={setTagInput}
              />
              <TextInput
                style={[styles.input, styles.textarea]}
                placeholder="Private notes about this person..."
                placeholderTextColor="#64748B"
                multiline
                value={notesInput}
                onChangeText={setNotesInput}
              />
              <TouchableOpacity style={styles.primaryBtn} onPress={handleSaveContact}>
                <Text style={styles.btnText}>Save to VaultCall</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Quick Number Pop-up Check</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter incoming number to check..."
                placeholderTextColor="#64748B"
                keyboardType="phone-pad"
                value={lookupPhone}
                onChangeText={setLookupPhone}
              />
              <View style={styles.matchBox}>
                <Text style={styles.matchTitle}>
                  {matchedContact ? matchedContact.name : "Unknown Caller"}
                </Text>
                <Text style={styles.matchSub}>
                  {matchedContact
                    ? matchedContact.notes || "Saved in VaultCall with no extra notes."
                    : "Not found in VaultCall (treated as Unknown Caller)."}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() => triggerCallerPopup(lookupPhone)}
              >
                <Text style={styles.btnText}>Simulate Incoming Call Pop-up</Text>
              </TouchableOpacity>
            </View>

            {contacts.map((c) => (
              <View key={c.id} style={styles.card}>
                <View style={styles.rowBetween}>
                  <Text style={styles.contactName}>{c.name}</Text>
                  <TouchableOpacity
                    style={styles.smallBtn}
                    onPress={() => triggerCallerPopup(c.phone)}
                  >
                    <Text style={styles.smallBtnText}>Pop-up</Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.phoneText}>{c.phone}</Text>
                {c.notes ? <Text style={styles.noteText}>{c.notes}</Text> : null}
              </View>
            ))}
          </View>
        )}

        {tab === "transcripts" && (
          <View style={styles.stack}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Conversation Logger & Transcript</Text>
              <TextInput
                style={styles.input}
                placeholder="Caller / Contact Phone"
                placeholderTextColor="#64748B"
                keyboardType="phone-pad"
                value={lookupPhone}
                onChangeText={setLookupPhone}
              />
              <View style={styles.rowGap}>
                <TouchableOpacity
                  style={[styles.speakerChip, speaker === "Me" && styles.speakerChipActive]}
                  onPress={() => setSpeaker("Me")}
                >
                  <Text style={styles.btnText}>{profile.name || "Me"}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.speakerChip,
                    speaker !== "Me" && styles.speakerChipActive,
                  ]}
                  onPress={() =>
                    setSpeaker(matchedContact ? matchedContact.name : lookupPhone || "Caller")
                  }
                >
                  <Text style={styles.btnText}>
                    {matchedContact ? matchedContact.name : lookupPhone || "Caller"}
                  </Text>
                </TouchableOpacity>
              </View>

              <TextInput
                style={styles.input}
                placeholder="Type or paste spoken line..."
                placeholderTextColor="#64748B"
                value={lineText}
                onChangeText={setLineText}
              />

              <View style={styles.rowGap}>
                <TouchableOpacity style={styles.secondaryBtnFlex} onPress={addTranscriptLine}>
                  <Text style={styles.btnText}>Add Line</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.recBtn, isRecording && styles.recBtnActive]}
                  onPress={startAudioRecording}
                >
                  <Text style={styles.btnText}>
                    {isRecording ? "Stop Audio" : "Record Audio"}
                  </Text>
                </TouchableOpacity>
              </View>

              {liveLines.map((l, idx) => (
                <View key={idx} style={styles.lineRow}>
                  <Text style={styles.lineText}>
                    <Text style={styles.bold}>{l.speaker}: </Text>
                    {l.text}
                  </Text>
                  <TouchableOpacity
                    style={styles.smallBtn}
                    onPress={() => speakLine(l.speaker, l.text)}
                  >
                    <Text style={styles.smallBtnText}>Speak</Text>
                  </TouchableOpacity>
                </View>
              ))}

              <TouchableOpacity style={styles.successBtn} onPress={saveTranscriptToVault}>
                <Text style={styles.btnText}>Save Transcript</Text>
              </TouchableOpacity>
            </View>

            {transcripts.map((tx) => (
              <View key={tx.id} style={styles.card}>
                <Text style={styles.contactName}>
                  {tx.contact_name || tx.contactName} ({tx.phone || "Unknown"})
                </Text>
                {(tx.lines || []).map((l, i) => (
                  <View key={i} style={styles.lineRow}>
                    <Text style={styles.lineText}>
                      <Text style={styles.bold}>{l.speaker}: </Text>
                      {l.text}
                    </Text>
                    <TouchableOpacity
                      style={styles.smallBtn}
                      onPress={() => speakLine(l.speaker, l.text)}
                    >
                      <Text style={styles.smallBtnText}>Listen</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            ))}
          </View>
        )}

        {tab === "logs" && (
          <View style={styles.stack}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Call & Recording History</Text>
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() => playLastRecording(lastAudioUri)}
              >
                <Text style={styles.btnText}>Play Latest Recording</Text>
              </TouchableOpacity>
            </View>

            {callLogs.length === 0 ? (
              <View style={styles.card}>
                <Text style={styles.matchSub}>No call or recording logs yet.</Text>
              </View>
            ) : (
              callLogs.map((log) => (
                <View key={log.id} style={styles.card}>
                  <Text style={styles.contactName}>
                    {log.name} ({log.number})
                  </Text>
                  <Text style={styles.phoneText}>{log.createdAt}</Text>
                  {log.notes ? <Text style={styles.noteText}>{log.notes}</Text> : null}
                  {log.audioUri ? (
                    <TouchableOpacity
                      style={styles.smallBtn}
                      onPress={() => playLastRecording(log.audioUri)}
                    >
                      <Text style={styles.smallBtnText}>Play Audio</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ))
            )}
          </View>
        )}

        {tab === "settings" && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Backend & App Preferences</Text>
            <Text style={styles.label}>Backend URL</Text>
            <TextInput
              style={styles.input}
              value={apiUrl}
              onChangeText={setApiUrlState}
              placeholder="https://vault-backend-t9nu.onrender.com"
              placeholderTextColor="#64748B"
            />
            <Text style={styles.label}>Your Name (for Speaker Tag)</Text>
            <TextInput
              style={styles.input}
              value={profile.name}
              onChangeText={(name) => setProfile({ ...profile, name })}
              placeholder="Me"
              placeholderTextColor="#64748B"
            />
            <Text style={styles.label}>Voice Language (hi-IN / en-IN)</Text>
            <TextInput
              style={styles.input}
              value={profile.lang}
              onChangeText={(lang) => setProfile({ ...profile, lang })}
              placeholder="hi-IN"
              placeholderTextColor="#64748B"
            />
            <View style={styles.switchRow}>
              <Text style={styles.lineText}>Auto-record flag preference</Text>
              <Switch value={autoRecord} onValueChange={setAutoRecordState} />
            </View>
            <TouchableOpacity style={styles.primaryBtn} onPress={handleSaveSettings}>
              <Text style={styles.btnText}>Save Settings</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      <Modal visible={popupVisible} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalBadge}>VAULTCALL POP-UP</Text>
            <Text style={styles.modalTitle}>
              {matchedContact ? matchedContact.name : "Unknown Caller"}
            </Text>
            <Text style={styles.phoneText}>{lookupPhone || "No Number"}</Text>
            <Text style={styles.modalNotes}>
              {matchedContact
                ? matchedContact.notes || "Saved contact in VaultCall."
                : "Number not saved in VaultCall."}
            </Text>

            <View style={styles.rowGap}>
              <TouchableOpacity
                style={[styles.recBtn, isRecording && styles.recBtnActive]}
                onPress={startAudioRecording}
              >
                <Text style={styles.btnText}>
                  {isRecording ? "Stop Recording" : "Start Recording"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.secondaryBtnFlex}
                onPress={() => setPopupVisible(false)}
              >
                <Text style={styles.btnText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#020617",
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#1E293B",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: {
    color: "#F8FAFC",
    fontSize: 22,
    fontWeight: "700",
  },
  status: {
    color: "#6EE7B7",
    fontSize: 12,
    marginTop: 2,
  },
  popupTriggerBtn: {
    backgroundColor: "#4F46E5",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  popupTriggerText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 12,
  },
  tabBar: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#1E293B",
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: "#0F172A",
    alignItems: "center",
  },
  tabBtnActive: {
    backgroundColor: "#4F46E5",
  },
  tabText: {
    color: "#94A3B8",
    fontSize: 12,
    fontWeight: "600",
  },
  tabTextActive: {
    color: "#FFFFFF",
  },
  content: {
    padding: 16,
  },
  stack: {
    gap: 14,
  },
  card: {
    backgroundColor: "#0F172A",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#1E293B",
    padding: 14,
    gap: 10,
  },
  cardTitle: {
    color: "#F8FAFC",
    fontSize: 16,
    fontWeight: "700",
  },
  label: {
    color: "#94A3B8",
    fontSize: 12,
    fontWeight: "600",
  },
  input: {
    backgroundColor: "#020617",
    color: "#F1F5F9",
    borderWidth: 1,
    borderColor: "#1E293B",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  textarea: {
    minHeight: 72,
    textAlignVertical: "top",
  },
  primaryBtn: {
    backgroundColor: "#4F46E5",
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
  },
  secondaryBtn: {
    backgroundColor: "#1E293B",
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: "center",
  },
  secondaryBtnFlex: {
    flex: 1,
    backgroundColor: "#1E293B",
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: "center",
  },
  successBtn: {
    backgroundColor: "#059669",
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
  },
  recBtn: {
    flex: 1,
    backgroundColor: "#0D9488",
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: "center",
  },
  recBtnActive: {
    backgroundColor: "#DC2626",
  },
  btnText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 13,
  },
  matchBox: {
    backgroundColor: "#020617",
    borderRadius: 10,
    padding: 10,
    gap: 4,
  },
  matchTitle: {
    color: "#6EE7B7",
    fontSize: 15,
    fontWeight: "700",
  },
  matchSub: {
    color: "#CBD5E1",
    fontSize: 13,
  },
  rowBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  rowGap: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  contactName: {
    color: "#F8FAFC",
    fontSize: 16,
    fontWeight: "700",
  },
  phoneText: {
    color: "#93C5FD",
    fontSize: 13,
  },
  noteText: {
    color: "#CBD5E1",
    fontSize: 13,
  },
  smallBtn: {
    backgroundColor: "#1E293B",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    alignSelf: "flex-start",
  },
  smallBtnText: {
    color: "#6EE7B7",
    fontSize: 12,
    fontWeight: "700",
  },
  speakerChip: {
    flex: 1,
    backgroundColor: "#020617",
    borderWidth: 1,
    borderColor: "#334155",
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: "center",
  },
  speakerChipActive: {
    backgroundColor: "#4F46E5",
    borderColor: "#4F46E5",
  },
  lineRow: {
    backgroundColor: "#020617",
    padding: 10,
    borderRadius: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  lineText: {
    flex: 1,
    color: "#F1F5F9",
    fontSize: 13,
  },
  bold: {
    fontWeight: "700",
    color: "#93C5FD",
  },
  switchRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(2, 6, 23, 0.82)",
    justifyContent: "center",
    padding: 20,
  },
  modalCard: {
    backgroundColor: "#0F172A",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#4F46E5",
    padding: 18,
    gap: 10,
  },
  modalBadge: {
    color: "#A5B4FC",
    fontSize: 11,
    fontWeight: "700",
  },
  modalTitle: {
    color: "#F8FAFC",
    fontSize: 20,
    fontWeight: "700",
  },
  modalNotes: {
    color: "#D1FAE5",
    fontSize: 14,
    backgroundColor: "#020617",
    padding: 10,
    borderRadius: 10,
  },
});
