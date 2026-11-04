import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Button,
  Image,
  Alert,
  StyleSheet,
  ScrollView,
  FlatList,
  TouchableOpacity,
} from 'react-native';

import { launchImageLibrary } from 'react-native-image-picker';

import ImageResizer from '@bam.tech/react-native-image-resizer';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_URL } from './src/config';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as RNFS from '@dr.pogodin/react-native-fs';
import NetInfo from '@react-native-community/netinfo';

const MAX_IMAGE_SIZE = 5_000_000;

export default function App() {
  const [currentScreen, setCurrentScreen] = useState<'create' | 'reports'>('create');
  const [description, setDescription] = useState('');
  const [images, setImages] = useState<
    { uri: string; size: number }[]
  >([]);
  const [reports, setReports] = useState<any[]>([]);
  const [uploadProgress, setUploadProgress] = useState<
    Record<string, {
      uploaded: number;
      total: number;
      currentImage: number;
      status: string;
    }>
  >({});
  const uploadInProgress = useRef(false);
  const retryAttempts = useRef(0);
  const nextRetryAt = useRef(0);
  useEffect(() => {
    console.log('Current screen changed to:', currentScreen);
  }, [currentScreen]);
  useEffect(() => {
    const checkConnection = async () => {
      const state = await NetInfo.fetch();

      if (state.isConnected && state.isInternetReachable !== false) {
        uploadPendingReports();
      }
    };

    checkConnection();
  }, []);
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      const connected =
        state.isConnected === true &&
        state.isInternetReachable !== false;

      console.log('Internet connected:', connected);

      if (connected) {
        uploadPendingReports();
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (currentScreen === 'reports') {
      loadReports();
    }
  }, [currentScreen]);
  async function loadReports() {
    try {
      const storedReports = await AsyncStorage.getItem('reports');

      const parsedReports = storedReports
        ? JSON.parse(storedReports)
        : [];
      console.log('Loaded reports:', parsedReports);

      setReports(parsedReports);
    } catch (error) {
      console.log('Error loading reports:', error);
    }
  }
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

      if (resized.size > MAX_IMAGE_SIZE) {
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

    setReports(reports);
    uploadPendingReports();
    Alert.alert('Success', 'Report saved locally');

    setDescription('');
    setImages([]);
  }
  function getRetryAfterMs(response: Response): number | null {
    const retryAfter = response.headers.get('Retry-After');

    if (!retryAfter) {
      return null;
    }

    // Backend sends seconds, for example: 5
    const seconds = Number(retryAfter);

    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }

    // Also support HTTP date format
    const retryDate = new Date(retryAfter).getTime();

    if (!Number.isNaN(retryDate)) {
      return Math.max(0, retryDate - Date.now());
    }

    return null;
  }
  async function uploadPendingReports() {
    if (uploadInProgress.current) {
      return;
    }
    if (Date.now() < nextRetryAt.current) {
      return;
    }
    uploadInProgress.current = true;

    try {
      const storedReports = await AsyncStorage.getItem('reports');
      const reports = storedReports ? JSON.parse(storedReports) : [];

      for (const report of reports) {
        // Skip reports that are already uploaded
        if (
          report.status === 'uploaded' ||
          report.status === 'failed'
        ) {
          continue;
        }

        try {
          const uploadedImages = [];
          const totalImages = report.images.length;

          setUploadProgress(previous => ({
            ...previous,
            [report.id]: {
              uploaded: 0,
              total: totalImages,
              currentImage: 1,
              status: 'uploading',
            },
          }));

          // Upload each image one by one
          for (let index = 0; index < totalImages; index++) {
            const image = report.images[index];

            const formData = new FormData();

            formData.append(
              'image',
              {
                uri: image.uri,
                type: 'image/jpeg',
                name: `image-${index}.jpg`,
              } as any,
            );

            const response = await fetch(
              `${API_URL}/reports/${report.id}/images/${index}`,
              {
                method: 'PUT',
                body: formData,
              },
            );

            const result = await response.json().catch(() => ({
              error: 'Invalid server response',
            }));

            if (!response.ok) {
              const error = new Error(JSON.stringify(result));
              (error as any).status = response.status;
              (error as any).retryAfterMs = getRetryAfterMs(response);
              throw error;
            }

            uploadedImages.push({
              index,
              size: result.size,
            });

            // Update upload progress
            setUploadProgress(previous => ({
              ...previous,
              [report.id]: {
                uploaded: uploadedImages.length,
                total: totalImages,
                currentImage: Math.min(index + 2, totalImages),
                status: 'uploading',
              },
            }));
          }

          // All images uploaded. Now commit the report.
          setUploadProgress(previous => ({
            ...previous,
            [report.id]: {
              uploaded: totalImages,
              total: totalImages,
              currentImage: totalImages,
              status: 'committing',
            },
          }));

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

          const commitResult = await commitResponse.json().catch(() => ({
            error: 'Invalid server response',
          }));
          if (!commitResponse.ok) {
            const error = new Error(JSON.stringify(commitResult));
            (error as any).status = commitResponse.status;
            (error as any).retryAfterMs = getRetryAfterMs(commitResponse);
            throw error;
          }

          // Mark report as uploaded
          report.status = 'uploaded';
          retryAttempts.current = 0;
          nextRetryAt.current = 0;
          // Save updated reports locally
          await AsyncStorage.setItem(
            'reports',
            JSON.stringify(reports),
          );

          setReports([...reports]);

          setUploadProgress(previous => ({
            ...previous,
            [report.id]: {
              uploaded: totalImages,
              total: totalImages,
              currentImage: totalImages,
              status: 'completed',
            },
          }));

          console.log('Report uploaded:', report.id);
        } catch (error) {
          const status = (error as any)?.status;

          console.log(`Upload failed for report ${report.id}:`, error);

          // Permanent client errors should not be retried automatically.
          const isPermanentError =
            typeof status === 'number' &&
            status >= 400 &&
            status < 500 &&
            status !== 408 &&
            status !== 429;

          if (isPermanentError) {
            console.log(`Permanent error: HTTP ${status}`);

            report.status = 'failed';

            await AsyncStorage.setItem('reports', JSON.stringify(reports));
            setReports([...reports]);

            setUploadProgress(previous => ({
              ...previous,
              [report.id]: {
                ...previous[report.id],
                status: 'failed',
              },
            }));

            break;
          }

          // Retry temporary errors and network failures.
          retryAttempts.current += 1;

          const serverRetryDelay = (error as any)?.retryAfterMs;

          const delay =
            typeof serverRetryDelay === 'number'
              ? serverRetryDelay
              : Math.min(
                1000 * Math.pow(2, retryAttempts.current - 1),
                30000,
              );

          nextRetryAt.current = Date.now() + delay;

          console.log(`Retrying in ${delay / 1000} seconds`);

          setUploadProgress(previous => ({
            ...previous,
            [report.id]: {
              ...previous[report.id],
              status: 'failed',
            },
          }));

          // Stop processing further reports until the retry.
          break;
        }
      }
    } catch (error) {
      // This catch handles errors outside the individual report uploads,
      // such as reading or parsing AsyncStorage.
      console.log('Error loading pending reports:', error);
    } finally {
      uploadInProgress.current = false;

      if (nextRetryAt.current > Date.now()) {
        const remainingDelay = nextRetryAt.current - Date.now();

        setTimeout(() => {
          uploadPendingReports();
        }, remainingDelay);
      }
    }
  }

  async function retryReport(reportId: string) {
    try {
      const storedReports = await AsyncStorage.getItem('reports');
      const reports = storedReports ? JSON.parse(storedReports) : [];

      const updatedReports = reports.map((report: any) =>
        report.id === reportId
          ? { ...report, status: 'pending' }
          : report,
      );

      await AsyncStorage.setItem(
        'reports',
        JSON.stringify(updatedReports),
      );

      setReports(updatedReports);

      // Reset retry delay so manual retry starts immediately.
      retryAttempts.current = 0;
      nextRetryAt.current = 0;

      uploadPendingReports();
    } catch (error) {
      console.log('Manual retry failed:', error);
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
    <SafeAreaView style={{ flex: 1, backgroundColor: '#F9FAFB' }}>
      <View style={styles.header}>
        <Button
          title="Create Report"
          onPress={() => setCurrentScreen('create')}
        />

        <Button
          title="My Reports"
          onPress={() => setCurrentScreen('reports')}
        />
      </View>
      {currentScreen === 'create' ? (

        <ScrollView>
          <View>
            {/* Your existing Create Report UI goes here */}
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
                {images.map((image, index) => (
                  <View key={`${image.uri}-${index}`} style={styles.imageWrapper}>
                    <Image
                      source={{ uri: image.uri }}
                      style={styles.image}
                    />

                    <TouchableOpacity
                      style={styles.removeImageButton}
                      onPress={() => {
                        setImages(currentImages =>
                          currentImages.filter((_, i) => i !== index),
                        );
                      }}>
                      <Text style={styles.removeImageText}>×</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>

              <Button title="Save Report" onPress={saveReport} />
            </View>
          </View>
        </ScrollView>
      ) : (
        <View style={styles.container}>
          <Text style={styles.title}>My Reports</Text>

          {reports.length === 0 ? (
            <Text style={styles.noReportsText}>No reports found.</Text>
          ) : (
            <FlatList
              data={reports}
              keyExtractor={item => item.id}
              renderItem={({ item }) => {
                console.log('Rendering report:', item);
                return (
                  <View style={styles.reportCard}>
                    <Text style={styles.reportDescription}>
                      {item.description}
                    </Text>

                    <Text>
                      Images: {item.images?.length ?? 0}
                    </Text>

                    <Text>
                      Created: {new Date(item.createdAt).toLocaleString()}
                    </Text>

                    <Text
                      style={{
                        color: item.status === 'uploaded' ? 'green' : 'orange',
                      }}>
                      Status: {item.status === 'uploaded' ? 'Uploaded' : 'Pending'}
                    </Text>
                    {item.status === 'failed' && (
                      <TouchableOpacity
                        onPress={() => retryReport(item.id)}
                        style={{
                          backgroundColor: '#2563EB',
                          padding: 10,
                          borderRadius: 8,
                          marginTop: 10,
                        }}>
                        <Text style={{ color: '#FFFFFF', textAlign: 'center' }}>
                          Retry Upload
                        </Text>
                      </TouchableOpacity>
                    )}
                    {uploadProgress[item.id] && (
                      <View style={{ marginTop: 12 }}>
                        <Text>
                          Images uploaded: {uploadProgress[item.id].uploaded}/
                          {uploadProgress[item.id].total}
                        </Text>

                        <Text>
                          Images remaining: {
                            uploadProgress[item.id].total -
                            uploadProgress[item.id].uploaded
                          }
                        </Text>

                        <View
                          style={{
                            height: 10,
                            backgroundColor: '#ddd',
                            borderRadius: 5,
                            marginTop: 8,
                            overflow: 'hidden',
                          }}>
                          <View
                            style={{
                              height: 10,
                              width: `${(uploadProgress[item.id].uploaded /
                                uploadProgress[item.id].total) * 100
                                }%`,
                              backgroundColor: '#16A34A',
                            }}
                          />
                        </View>

                        <Text>
                          {uploadProgress[item.id].status === 'committing'
                            ? 'Finalizing report...'
                            : uploadProgress[item.id].status === 'completed'
                              ? 'Upload completed'
                              : `Uploading image ${uploadProgress[item.id].currentImage}`}
                        </Text>
                      </View>
                    )}

                    <View style={styles.imageContainer}>
                      {item.images?.map((image: any, index: number) => (
                        <Image
                          key={`${item.id}-${index}`}
                          source={{ uri: image.uri }}
                          style={styles.image}
                        />
                      ))}
                    </View>
                  </View>
                )
              }}
            />
          )}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    justifyContent: 'center',
    backgroundColor: '#F9FAFB',
  },

  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 16,
    color: 'black',
  },
  noReportsText: {
    fontSize: 18,
    color: '#555',
    textAlign: 'center',
    marginTop: 20,
  },

  reportCard: {
    padding: 15,
    marginBottom: 15,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
  },

  reportDescription: {
    fontSize: 17,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 20,
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
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 10,
  },
  image: {
    width: 150,
    height: 150,
    marginVertical: 20,
    borderRadius: 10,
  },
  progressBackground: {
    height: 10,
    backgroundColor: '#ddd',
    borderRadius: 5,
    marginTop: 8,
    overflow: 'hidden',
  },

  progressFill: {
    height: 10,
    backgroundColor: '#16A34A',
    borderRadius: 5,
  },

  imageWrapper: {
    position: 'relative',
  },


  removeImageButton: {
    position: 'absolute',
    top: -8,
    right: -8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'red',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1,
  },

  removeImageText: {
    color: 'white',
    fontSize: 18,
    fontWeight: 'bold',
    lineHeight: 21,
  },
});