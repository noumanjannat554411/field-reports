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

import { launchImageLibrary, launchCamera } from 'react-native-image-picker';

import ImageResizer from '@bam.tech/react-native-image-resizer';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_URL } from './src/config';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as RNFS from '@dr.pogodin/react-native-fs';
import NetInfo from '@react-native-community/netinfo';

const MAX_IMAGE_SIZE = 5_000_000;

export default function App() {
  const [currentScreen, setCurrentScreen] = useState<'create' | 'reports' | 'server'>('create');
  const [description, setDescription] = useState('');
  const [images, setImages] = useState<
    { uri: string; size: number }[]
  >([]);
  const [reports, setReports] = useState<any[]>([]);
  const [serverReports, setServerReports] = useState<any[]>([]);
  const [loadingServerReports, setLoadingServerReports] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<
    Record<string, {
      uploaded: number;
      total: number;
      currentImage: number;
      status: string;
    }>
  >({});
  const uploadInProgress = useRef(false);
  const retryAttempts = useRef<Record<string, number>>({});
  const nextRetryAt = useRef<Record<string, number>>({});
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
  const fetchServerReports = async () => {
    try {
      setLoadingServerReports(true);

      const response = await fetch(`${API_URL}/reports`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      console.log('Fetched server reports:', data.reports);

      setServerReports(data.reports || []);
    } catch (error) {
      console.log('Failed to fetch server reports:', error);
      Alert.alert('Error', 'Unable to fetch server reports');
    } finally {
      setLoadingServerReports(false);
    }
  };
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
  const openCamera = async () => {
    try {
      if (images.length >= 5) {
        Alert.alert('Limit reached', 'Maximum 5 images allowed');
        return;
      }

      const result = await launchCamera({
        mediaType: 'photo',
        cameraType: 'back',
        quality: 1,
        saveToPhotos: false,
      });

      if (result.didCancel) {
        return;
      }

      if (result.errorCode) {
        Alert.alert(
          'Camera Error',
          result.errorMessage || result.errorCode,
        );
        return;
      }

      const asset = result.assets?.[0];

      if (!asset?.uri) {
        return;
      }

      // Compress the captured image
      const resized = await ImageResizer.createResizedImage(
        asset.uri,
        1600,
        1600,
        'JPEG',
        80,
      );

      if (resized.size > MAX_IMAGE_SIZE) {
        Alert.alert('Error', 'Image must be less than 5 MB');
        return;
      }

      // Save permanently inside app storage
      const permanentUri = await saveImagePermanently(resized.uri);

      // Add image to existing images
      setImages(currentImages => {
        if (currentImages.length >= 5) {
          return currentImages;
        }

        return [
          ...currentImages,
          {
            uri: permanentUri,
            fileName: `camera-${Date.now()}.jpg`,
            type: 'image/jpeg',
            fileSize: resized.size,
          },
        ];
      });

    } catch (error) {
      console.log('Camera error:', error);
      Alert.alert('Error', 'Unable to capture image');
    }
  };

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
    uploadInProgress.current = true;
    let nextScheduledRetryAt = 0;
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

        // Check whether this particular report is ready for retry.
        const retryTime = nextRetryAt.current[report.id] || 0;

        if (Date.now() < retryTime) {
          if (
            nextScheduledRetryAt === 0 ||
            retryTime < nextScheduledRetryAt
          ) {
            nextScheduledRetryAt = retryTime;
          }

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

            // const result = await response.json().catch(() => ({
            //   error: 'Invalid server response',
            // }));

            const responseText = await response.text();

            console.log('Image upload response:', {
              status: response.status,
              body: responseText,
            });

            let result;

            try {
              result = JSON.parse(responseText);
            } catch {
              const error = new Error(
                `Invalid server response: HTTP ${response.status}`,
              );

              (error as any).status = response.status;
              throw error;
            }

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
          delete retryAttempts.current[report.id];
          delete nextRetryAt.current[report.id];
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
          retryAttempts.current[report.id] =
            (retryAttempts.current[report.id] || 0) + 1;

          const serverRetryDelay = (error as any)?.retryAfterMs;

          const delay =
            typeof serverRetryDelay === 'number'
              ? serverRetryDelay
              : Math.min(
                1000 * Math.pow(
                  2,
                  retryAttempts.current[report.id] - 1,
                ),
                30000,
              );

          nextRetryAt.current[report.id] = Date.now() + delay;
          const scheduledTime = Date.now() + delay;

          if (
            nextScheduledRetryAt === 0 ||
            scheduledTime < nextScheduledRetryAt
          ) {
            nextScheduledRetryAt = scheduledTime;
          }
          console.log(
            `Retrying report ${report.id} in ${delay / 1000} seconds`,
          );

          setUploadProgress(previous => ({
            ...previous,
            [report.id]: {
              ...previous[report.id],
              status: 'failed',
            },
          }));

          // Stop processing further reports until the retry.
          continue;
        }
      }
    } catch (error) {
      // This catch handles errors outside the individual report uploads,
      // such as reading or parsing AsyncStorage.
      console.log('Error loading pending reports:', error);
    } finally {
      uploadInProgress.current = false;

      if (nextScheduledRetryAt > Date.now()) {
        const remainingDelay =
          nextScheduledRetryAt - Date.now();

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
      delete retryAttempts.current[reportId];
      delete nextRetryAt.current[reportId];

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
  const getServerImageUrl = (imageUrl: string) => {
    return `${API_URL}${imageUrl}`;
  };
  const resetLocalData = () => {
    Alert.alert(
      'Reset Local Data',
      'This will permanently delete all local reports and their images, including pending uploads. Server reports will not be affected. Continue?',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            try {
              // Prevent reset while uploads are running
              if (uploadInProgress.current) {
                Alert.alert(
                  'Upload in Progress',
                  'Please wait until the current upload finishes.',
                );
                return;
              }

              // Delete local report images
              const imageDirectory =
                `${RNFS.DocumentDirectoryPath}/report-images`;

              if (await RNFS.exists(imageDirectory)) {
                await RNFS.unlink(imageDirectory);
              }

              // Delete locally saved reports
              await AsyncStorage.removeItem('reports');

              // Clear retry tracking
              retryAttempts.current = {};
              nextRetryAt.current = {};

              // Clear UI
              setReports([]);
              setImages([]);
              setDescription('');

              Alert.alert(
                'Reset Complete',
                'All local reports and images have been deleted.',
              );
            } catch (error) {
              console.log('Reset failed:', error);
              Alert.alert('Error', 'Unable to reset local data.');
            }
          },
        },
      ],
    );
  };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#F9FAFB' }}>
      <View style={styles.header}>

        <TouchableOpacity
          style={styles.tabContainer}
          onPress={() => {
            setCurrentScreen('create');
          }}>
          <Text style={styles.tabText}>Create Report</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.tabContainer}
          onPress={() => {
            setCurrentScreen('reports');
          }}>
          <Text style={styles.tabText}>My Reports</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.tabContainer}
          onPress={() => {
            setCurrentScreen('server');
            fetchServerReports();
          }}>
          <Text style={styles.tabText}>Server Reports</Text>
        </TouchableOpacity>
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

              {/* <Button
                title={`Select Images (${images.length}/5)`}
                onPress={selectImages}
              />
              <Button
                title="Upload Pending Reports"
                onPress={uploadPendingReports}
              /> */}
              <View style={{ flexDirection: 'row', gap: 10 }}>

                <TouchableOpacity
                  style={[styles.button, { flex: 1 }]}
                  onPress={openCamera}>
                  <Text style={styles.buttonText}>
                    Take Photo
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.button, { flex: 1 }]}
                  onPress={selectImages}>
                  <Text style={styles.buttonText}>
                    Select Gallery
                  </Text>
                </TouchableOpacity>

              </View>
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
      ) : currentScreen === 'server' ? (
        <View style={{ flex: 1, padding: 20 }}>
          <TouchableOpacity
            style={styles.button}
            onPress={fetchServerReports}
            disabled={loadingServerReports}>
            <Text style={styles.buttonText}>
              {loadingServerReports ? 'Loading...' : 'Refresh'}
            </Text>
          </TouchableOpacity>

          <FlatList
            data={serverReports}
            keyExtractor={item => String(item.id)}
            contentContainerStyle={{ paddingBottom: 30 }}
            renderItem={({ item }) => (
              <View style={styles.reportCard}>
                <Text style={styles.reportDescription}>
                  {item.description}
                </Text>

                <Text style={styles.reportDetail}>
                  Report ID: {item.id}
                </Text>

                <Text style={styles.reportDetail}>
                  Status: Uploaded
                </Text>

                <Text style={styles.reportDetail}>
                  Created: {new Date(item.createdAt).toLocaleString()}
                </Text>

                <Text style={styles.reportDetail}>
                  Images: {item.images?.length || 0}
                </Text>

                <View style={styles.imageContainer}>
                  {item.images?.map(
                    (image: { index: number; size: number; url: string }) => (
                      <Image
                        key={`${item.id}-${image.index}`}
                        source={{ uri: getServerImageUrl(image.url) }}
                        style={styles.serverImage}
                        resizeMode="cover"
                      />
                    ),
                  )}
                </View>
              </View>
            )}
            ListEmptyComponent={
              <Text style={styles.emptyText}>
                {loadingServerReports
                  ? 'Loading server reports...'
                  : 'No server reports found'}
              </Text>
            }
          />
        </View>
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
          <TouchableOpacity
            style={styles.resetButton}
            onPress={resetLocalData}>
            <Text style={styles.resetButtonText}>
              Reset Local Data
            </Text>
          </TouchableOpacity>
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
  resetButton: {
    backgroundColor: '#DC2626',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 12,
  },

  resetButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 20,
    elevation: 2,
    backgroundColor: '#FFFFFF',
    paddingVertical: 10,
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
  tabContainer: {
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 8,

  },
  tabText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  button: {
    backgroundColor: '#2563EB',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 8,
  },

  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
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
  reportDetail: {
    fontSize: 13,
    color: '#6B7280',
    marginTop: 5,
  },

  serverImage: {
    width: 100,
    height: 100,
    borderRadius: 8,
    backgroundColor: '#E5E7EB',
  },

  emptyText: {
    textAlign: 'center',
    color: '#6B7280',
    marginTop: 30,
  },
});