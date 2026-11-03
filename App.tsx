import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Button,
  Image,
  Alert,
  StyleSheet,
  ScrollView,
} from 'react-native';

import { launchImageLibrary } from 'react-native-image-picker';

import ImageResizer from '@bam.tech/react-native-image-resizer';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_URL } from './src/config';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as RNFS from '@dr.pogodin/react-native-fs';

const MAX_IMAGE_SIZE = 5_000_000;

export default function App() {
  const [description, setDescription] = useState('');
  const [images, setImages] = useState<
    { uri: string; size: number }[]
  >([]);
  const [imageSize, setImageSize] = useState<number | null>(null);

  async function selectImages() {
    const result = await launchImageLibrary({
      mediaType: 'photo',
      selectionLimit: 5,
    });

    if (result.didCancel || !result.assets?.length) {
      return;
    }

    const remainingSlots = 5 - images.length;

    if (remainingSlots <= 0) {
      Alert.alert('Limit reached', 'You can select up to 5 images.');
      return;
    }

    const selectedAssets = result.assets.slice(0, remainingSlots);
    const preparedImages: { uri: string; size: number }[] = [];
    console.log('Selected assets:', selectedAssets);


    for (const asset of selectedAssets) {
      if (!asset.uri) {
        continue;
      }

      const resized = await ImageResizer.createResizedImage(
        asset.uri,
        1600,
        1600,
        'JPEG',
        80,
      );

      if (resized.size > 5_000_000) {
        Alert.alert(
          'Image too large',
          'One image is still larger than 5 MB. Please select another image.',
        );
        continue;
      }

      const permanentUri = await saveImagePermanently(resized.path);

      preparedImages.push({
        uri: permanentUri,
        size: resized.size,
      });
    }
    console.log('Prepared images:', preparedImages);
    setImages(previous => [...previous, ...preparedImages]);
  }

  async function saveReport() {
    if (!description.trim()) {
      Alert.alert('Error', 'Description is required');
      return;
    }

    if (images.length < 1 || images.length > 5) {
      Alert.alert('Error', 'Select between 1 and 5 images');
      return;
    }

    const report = {
      id: Date.now().toString(),
      description: description.trim(),
      images,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };

    const existing = await AsyncStorage.getItem('reports');
    const reports = existing ? JSON.parse(existing) : [];

    reports.push(report);

    await AsyncStorage.setItem('reports', JSON.stringify(reports));

    Alert.alert('Success', 'Report saved locally');

    setDescription('');
    setImages([]);
  }

  async function uploadPendingReports() {
    try {
      const storedReports = await AsyncStorage.getItem('reports');
      const reports = storedReports ? JSON.parse(storedReports) : [];

      for (const report of reports) {
        if (report.status === 'uploaded') {
          continue;
        }

        const uploadedImages = [];

        // Upload each image one by one
        for (let index = 0; index < report.images.length; index++) {
          const image = report.images[index];

          const formData = new FormData();

          formData.append('image', {
            uri: image.uri,
            type: 'image/jpeg',
            name: `image-${index}.jpg`,
          } as any);

          const response = await fetch(
            `${API_URL}/reports/${report.id}/images/${index}`,
            {
              method: 'PUT',
              body: formData,
            },
          );

          const result = await response.json();

          if (!response.ok) {
            throw new Error(JSON.stringify(result));
          }

          uploadedImages.push({
            index,
            size: result.size,
          });
        }

        // Commit report after all images are uploaded
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
              images: uploadedImages,
            }),
          },
        );

        const commitResult = await commitResponse.json();

        if (!commitResponse.ok) {
          throw new Error(JSON.stringify(commitResult));
        }

        report.status = 'uploaded';

        await AsyncStorage.setItem(
          'reports',
          JSON.stringify(reports),
        );

        console.log('Report uploaded:', report.id);
      }

      Alert.alert('Success', 'All pending reports uploaded');
    } catch (error) {
      console.log('Upload error:', error);
      Alert.alert('Upload failed', String(error));
    }
  }
  async function saveImagePermanently(sourcePath: string): Promise<string> {
    const directoryPath = `${RNFS.DocumentDirectoryPath}/report-images`;

    const directoryExists = await RNFS.exists(directoryPath);

    if (!directoryExists) {
      await RNFS.mkdir(directoryPath);
    }

    const fileName = `report-${Date.now()}-${Math.random()
      .toString(36)
      .substring(2)}.jpg`;

    const destinationPath = `${directoryPath}/${fileName}`;

    await RNFS.copyFile(sourcePath, destinationPath);

    return `file://${destinationPath}`;
  }
  return (
    <SafeAreaView>
      <ScrollView>
        <View style={styles.container}>
          <Text style={styles.heading}>Field Reports</Text>

          <TextInput
            style={styles.input}
            placeholder="Enter report description"
            value={description}
            onChangeText={setDescription}
            multiline
          />

          <Button
            title={`Select Images (${images.length}/5)`}
            onPress={selectImages}
          />
          <Button
            title="Upload Pending Reports"
            onPress={uploadPendingReports}
          />

          <View style={styles.imageContainer}>
            {images.map((item, index) => (
              <View key={`${item.uri}-${index}`}>
                <Image
                  source={{ uri: item.uri }}
                  style={styles.image}
                />

                <Text>
                  Image {index + 1} — {(item.size / 1024).toFixed(1)} KB
                </Text>

                <Button
                  title="Remove"
                  onPress={() => {
                    setImages(previous =>
                      previous.filter((_, i) => i !== index),
                    );
                  }}
                />
              </View>
            ))}
          </View>

          <Button title="Save Report" onPress={saveReport} />
        </View>
      </ScrollView>
    </SafeAreaView>
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
  imageContainer: {
    marginVertical: 15,
    gap: 15,
  },
  image: {
    width: 150,
    height: 150,
    marginVertical: 20,
    borderRadius: 10,
  },
});