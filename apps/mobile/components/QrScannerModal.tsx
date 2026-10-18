/**
 * Full-screen QR scanner for the mobile wallet.
 *
 * Wraps expo-camera's CameraView. Handles the three permission states
 * (undetermined → ask, denied → settings hint, granted → live camera), and
 * a camera that fails to start says so with a retry instead of staying a
 * black screen. "Upload QR image" decodes a QR from a photo or screenshot
 * (expo-image-picker + expo-camera's scanFromURLAsync) — available in every
 * state, so a blocked camera never leaves the user stuck (client 2026-10-16).
 * Emits the decoded payload exactly once per open via `onResult`, then
 * the parent closes the modal.
 *
 * Used by the Send screen (scan a recipient address) and — once mobile
 * WalletConnect lands — the WC pairing flow (scan a wc: URI). The
 * caller decides what the payload means; this component just decodes.
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, Linking, ActivityIndicator, Alert,
} from 'react-native';
import { Modal } from './ActivityModal';
import { CameraView, useCameraPermissions, scanFromURLAsync } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { X, ImageUp } from 'lucide-react-native';

interface Props {
  visible:  boolean;
  onClose:  () => void;
  /** Fires once with the raw scanned string. Parent normalises it. */
  onResult: (data: string) => void;
  /** Optional heading copy — e.g. "Scan recipient" or "Scan WalletConnect QR". */
  title?:   string;
}

export function QrScannerModal({ visible, onClose, onResult, title = 'Scan QR code' }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  /* Guard against expo-camera firing onBarcodeScanned dozens of times
     per second — we want exactly one result per modal open. */
  const [handled, setHandled] = useState(false);
  /* The camera failed to start (in use by another app, hardware error).
     `cameraKey` remounts CameraView for "Try again". */
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraKey, setCameraKey] = useState(0);
  const [decoding, setDecoding] = useState(false);

  useEffect(() => {
    if (visible) { setHandled(false); setCameraError(null); }
  }, [visible]);

  // Auto-prompt for permission the first time the modal opens.
  useEffect(() => {
    if (visible && permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [visible, permission, requestPermission]);

  const handleScan = (data: string) => {
    if (handled || !data) return;
    setHandled(true);
    onResult(data);
  };

  /** Pick a photo / screenshot and read the QR code in it. */
  const uploadQr = async () => {
    if (decoding) return;
    try {
      const pick = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      if (pick.canceled || !pick.assets?.[0]?.uri) return;
      setDecoding(true);
      const found = await scanFromURLAsync(pick.assets[0].uri, ['qr']);
      const data = found.find((r) => !!r.data)?.data;
      if (!data) {
        Alert.alert('No QR code found', "Couldn't find a QR code in that image. Try a clearer screenshot, cropped to the code.");
        return;
      }
      handleScan(data);
    } catch {
      Alert.alert('Couldn’t read the image', 'That image could not be opened. Try another photo or screenshot.');
    } finally {
      setDecoding(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent={false}>
      <View style={styles.root}>
        {/* Camera or permission state */}
        {!permission ? (
          <View style={styles.center}>
            <ActivityIndicator color="#fff"/>
          </View>
        ) : !permission.granted ? (
          <View style={styles.center}>
            <Text style={styles.permTitle}>Camera access needed</Text>
            <Text style={styles.permBody}>
              Thanos Wallet needs the camera to scan QR codes. {permission.canAskAgain
                ? 'Tap below to allow access.'
                : 'Enable camera access for Thanos Wallet in your device settings.'}
            </Text>
            <Pressable
              style={styles.permBtn}
              onPress={() => {
                if (permission.canAskAgain) void requestPermission();
                else void Linking.openSettings();
              }}
            >
              <Text style={styles.permBtnText}>
                {permission.canAskAgain ? 'Allow camera' : 'Open settings'}
              </Text>
            </Pressable>
          </View>
        ) : cameraError ? (
          <View style={styles.center}>
            <Text style={styles.permTitle}>Couldn’t start the camera</Text>
            <Text style={styles.permBody}>
              {cameraError} Close any other app using the camera and try again, or upload a picture of the QR code.
            </Text>
            <Pressable style={styles.permBtn} onPress={() => { setCameraError(null); setCameraKey((k) => k + 1); }}>
              <Text style={styles.permBtnText}>Try again</Text>
            </Pressable>
          </View>
        ) : (
          <CameraView
            key={cameraKey}
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={handled ? undefined : ({ data }) => handleScan(data)}
            onMountError={(e) => setCameraError(e?.message ? `${e.message.replace(/\.?$/, '.')}` : 'The camera didn’t respond.')}
          />
        )}

        {/* Scan-frame overlay (only over a live camera) */}
        {permission?.granted && !cameraError && (
          <View style={styles.overlay} pointerEvents="none">
            <View style={styles.frame}>
              <View style={[styles.corner, styles.tl]}/>
              <View style={[styles.corner, styles.tr]}/>
              <View style={[styles.corner, styles.bl]}/>
              <View style={[styles.corner, styles.br]}/>
            </View>
            <Text style={styles.hint}>Point the camera at a QR code</Text>
          </View>
        )}

        {/* Upload a QR image — in every state, so a blocked or failing camera
            never leaves the user stuck. */}
        {permission && (
          <View style={styles.footer} pointerEvents="box-none">
            <Pressable
              onPress={uploadQr}
              disabled={decoding}
              accessibilityRole="button"
              accessibilityLabel="Upload a QR code image"
              style={({ pressed }) => [styles.uploadBtn, (pressed || decoding) && { opacity: 0.7 }]}
            >
              {decoding
                ? <ActivityIndicator color="#fff" size="small"/>
                : <ImageUp size={18} color="#fff" strokeWidth={2.2}/>}
              <Text style={styles.uploadText}>{decoding ? 'Reading QR code…' : 'Upload QR image'}</Text>
            </Pressable>
          </View>
        )}

        {/* Header — title + close, always on top */}
        <View style={styles.header} pointerEvents="box-none">
          <Text style={styles.title}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={16} style={styles.closeBtn}>
            <X size={22} color="#fff" strokeWidth={2.4}/>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const ACCENT = '#3b7af7';

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },

  permTitle: { color: '#fff', fontSize: 20, fontWeight: '700', textAlign: 'center' },
  permBody:  { color: '#bbb', fontSize: 14, textAlign: 'center', lineHeight: 21 },
  permBtn:   { marginTop: 8, backgroundColor: ACCENT, paddingVertical: 13, paddingHorizontal: 28, borderRadius: 12 },
  permBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  frame:   { width: 248, height: 248 },
  corner:  { position: 'absolute', width: 34, height: 34, borderColor: ACCENT },
  tl: { top: 0, left: 0,  borderTopWidth: 4,    borderLeftWidth: 4 },
  tr: { top: 0, right: 0, borderTopWidth: 4,    borderRightWidth: 4 },
  bl: { bottom: 0, left: 0,  borderBottomWidth: 4, borderLeftWidth: 4 },
  br: { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4 },
  hint: { color: '#fff', fontSize: 13, marginTop: 28, opacity: 0.85 },

  header: {
    position: 'absolute', top: 0, left: 0, right: 0,
    paddingTop: 54, paddingHorizontal: 18, paddingBottom: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  title:    { color: '#fff', fontSize: 17, fontWeight: '700' },
  closeBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },

  footer: { position: 'absolute', left: 0, right: 0, bottom: 56, alignItems: 'center' },
  uploadBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 12, paddingHorizontal: 20, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.14)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)',
  },
  uploadText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
