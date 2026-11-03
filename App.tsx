import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Button,
  Image,
  Alert,
  StyleSheet,
} from 'react-native';

import { launchImageLibrary } from 'react-native-image-picker';

import ImageResizer from '@bam.tech/react-native-image-resizer';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_URL } from './src/config';

const MAX_IMAGE_SIZE = 5_000_000;

export default function App() {
  const [description, setDescription] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<number | null>(null);

  // Select image from gallery
  async function selectImage() {
    const result = await launchImageLibrary({
      mediaType: 'photo',
      selectionLimit: 1,
    });

    if (result.didCancel || !result.assets?.[0]?.uri) {
      return;
    }

    const uri = result.assets[0].uri;

    // Compress image
    const resized = await ImageResizer.createResizedImage(
      uri,
      1600,
      1600,
      'JPEG',
      80,
    );

    if (resized.size > MAX_IMAGE_SIZE) {
      Alert.alert('Image too large', 'Please select a smaller image.');
      return;
    }

    setImage(resized.uri);
    setImageSize(resized.size);
  }

  // Save report locally
  async function saveReport() {
    if (!description.trim()) {
      Alert.alert('Error', 'Description is required');
      return;
    }

    if (!image) {
      Alert.alert('Error', 'Please select an image');
      return;
    }

    const report = {
      id: Date.now().toString(),
      description: description.trim(),
      image,
      imageSize,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };

    const existing = await AsyncStorage.getItem('reports');

    const reports = existing ? JSON.parse(existing) : [];

    reports.push(report);

    await AsyncStorage.setItem('reports', JSON.stringify(reports));

    Alert.alert('Success', 'Report saved locally');

    setDescription('');
    setImage(null);
    setImageSize(null);
  }


  async function uploadPendingReports() {
    try {
      const storedReports = await AsyncStorage.getItem('reports');
      const reports = storedReports ? JSON.parse(storedReports) : [];

      for (const report of reports) {
        if (report.status === 'uploaded') {
          continue;
        }

        // Step 1: Upload image
        const formData = new FormData();

        formData.append('image', {
          uri: report.image,
          type: 'image/jpeg',
          name: 'image.jpg',
        } as any);

        const imageResponse = await fetch(
          `${API_URL}/reports/${report.id}/images/0`,
          {
            method: 'PUT',
            body: formData,
          },
        );

        if (!imageResponse.ok) {
          throw new Error(`Image upload failed: ${imageResponse.status}`);
        }
        const imageData = JSON.parse(await imageResponse.text());
        console.log('Image upload response:', imageData);
        // Step 2: Commit report
        const commitResponse = await fetch(
          `${API_URL}/reports/${report.id}/commit`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              description: report.description,
              createdAt: report.createdAt,
              images: [
                {
                  index: 0,
                  size: imageData.size,
                },
              ],
            }),
          },
        );

        if (!commitResponse.ok) {
          console.log('Commit response:', await commitResponse.text());
          throw new Error(`Report commit failed: ${commitResponse.status}`);
        }

        // Step 3: Mark report as uploaded
        report.status = 'uploaded';

        await AsyncStorage.setItem(
          'reports',
          JSON.stringify(reports),
        );
      }

      Alert.alert('Success', 'Pending reports uploaded successfully');
    } catch (error) {
      console.log('Upload error:', error);
      Alert.alert('Upload failed', String(error));
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Field Reports</Text>

      <TextInput
        style={styles.input}
        placeholder="Enter report description"
        value={description}
        onChangeText={setDescription}
        multiline
      />

      <Button title="Select Image" onPress={selectImage} />
      <Button
        title="Upload Pending Reports"
        onPress={uploadPendingReports}
      />

      {image && (
        <Image
          source={{ uri: image }}
          style={styles.image}
        />
      )}

      <Button title="Save Report" onPress={saveReport} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    justifyContent: 'center',
  },
  heading: {
    fontSize: 25,
    fontWeight: 'bold',
    marginBottom: 25,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    height: 100,
    marginBottom: 20,
    textAlignVertical: 'top',
  },
  image: {
    width: 150,
    height: 150,
    marginVertical: 20,
    borderRadius: 10,
  },
});