'use strict'
/**
 * @copyright Copyright 2020, Jaegeon Jo, All rights reserved
 * @author Jaegeon Jo <jlucete@gmail.com>
 * @version 0.0.1
 *
 * [On browser Audio Recognizer]
 * Purpose:
 *  - Model comparison ( Available models are transformer, vggbLSTM, monica )
 *  - On browser speech recognition ( i.e. without communication with server )
 *
 * Usage:
 *  - select model
 *    let recognizer = new Recognizer();
 *    recognizer.selectModel("transformer");
 *
 *  - load audio to predict
 *    * using file path
 *    recognizer.predictAudioFile("./audio/vc_test.wav");
 *    * using arraybuffer(Float32Array)
 *    recognizer.predictAudioBuffer(audiobuffer);
 *
 *
 *  - change model (Optional)
 *    recognizer.selectModel("vggbLSTM");
 *
 *  - start recording for single audio recognition
 *    recognizer.startRecord();
 *
 *  - stop recording for single audio recognition
 *    recognizer.stopRecord();
 *
 *  - start streaming speech recognition
 *    recognizer.startListen();
 *
 *  - stop streaming speech recognition
 *    recognizer.stopListen();
 *
 *  - get prediction result
 *    recognizer.result()
 *              .then(console.log);
 *
 *
 *
 *
 * Note:
 *  - Audio will be automatically downsampled to 16k
 *  - Your browser should support Web Audio API
 *
 */
let AudioContext = window.AudioContext || window.webkitAudioContext;

let MINLEN = {
  "sample": 187,
  "monica": 650
}

class Recognizer {
    constructor() {
        // TODO: Add Event trigger for listening.
        this.sampleRate = 16000;
        this.fftSize = 512;
        // Audio setting
        this.audioCtx=null;
        this.audioBuffer=[];

        // Audio preprocessing
        this.melSpectrogram = null;

        // Model setting
        this.modelName = "";
        this.model = null;  // ! Promise
        this.dictionary = null; // ! Promise
        this.minLength = null;

        // Prediction setting
        this.result = null; // ! Promise

        // Recording setting
        this.isRecord = false;
        this.recordStream = null;
        this.recordSource = null;
        this.recordProcessor = null;

        // Listening setting
        this.isListen = false;
        this.listenStream = null;
        this.listenSource = null;
        this.listenProcessor = null;
        this.listenAudioCtx = null;
        this.listenSampleRate = 44100;
        this.threshold = 0.01;
        this.listenStreamSize = 4096;

        // Event obj for listen.
        this.onResult = null;

        // debug
        this.resultArray = [];

        this.toString = function () {
          return `Recognizer(${this.modelName})`;
        }
    }


    /**
     * Select model for speech recognition.
     * Available models are "transformer", "vggbLSTM", "monica"
     * @param {string} modelName Model name for speech recognition
     * @return {void} Return nothing
     * @example
     * let recognizer = new Recognizer();
     * recognizer.selectModel("transformer");
     *
     */
    async selectModel(modelName) {
      // TODO: use tf.dispose to release the memory
      this.minLength = MINLEN[modelName];
      this.model = this.loadModel(modelName);
      this.dictionary = this.loadDictionary(modelName);
    }

    async loadModel(modelName) {
        console.log("Load model: "+modelName);
        this.modelName = modelName;
        return tf.loadGraphModel(`https://${window.location.hostname}/models/${modelName}/model.json`);
    }

    async loadDictionary(modelName) {
      // Load proper Dictionary
      console.log("Loading JSON");
      return $.getJSON(`https://${window.location.hostname}/models/${modelName}/token_list.json`);
    }

    /**
     * Predict single audio file.
     * Recognition model should be selected.
     * @param {string} filePath file path for audio file
     * @return {string} prediction result
     * @example
     * let recognizer = new Recognizer();
     * recognizer.selectModel("transformer");
     * recognizer.predictSingleAudio("./audio/vc_test.wav");
     *
     */
    async predictAudioFile(filePath) {
      // FIXME: Change result[1]['token_list] to result[1]
      //        This code is only available for "sample" model.
      this.audioCtx = new AudioContext({
        latencyHint: 'interactive',
        sampleRate: this.sampleRate,
      });
      let input = this.loadAudio(filePath)
                      .then((audioArray) => createMelSpectrogram(this.zeroPadding(audioArray.getChannelData(0))));
      return Promise.all([this.model, this.dictionary, input])
                    .then(
                      (result) => {
                        return this.predict(result[0], result[1]['token_list'], result[2]);
                      }
                    );
    }

    /**
     * Predict single audio buffer.
     * Recognition model should be selected.
     * Assume sample rate = 16k
     * @param {audiobuffer} audioBuffer audioBuffer that has .getChannelData() method.
     * @return {string} prediction result
     * @example
     * let audioCtx = new AudioContext();
     * let audioBuffer = audioCtx.createBufferSource();
     * let recognizer = new Recognizer();
     * recognizer.selectModel("transformer");
     * recognizer.predictSingleAudio(audioBuffer);
     *
     */
    async predictAudioBuffer(audioBuffer) {
      // FIXME: Change result[1]['token_list] to result[1]
      //        This code is only available for "sample" model.

      let input = createMelSpectrogram(this.zeroPadding(audioBuffer));
      return Promise.all([this.model, this.dictionary, input])
                    .then(
                      (result) => {
                        return this.predict(result[0], result[1]['token_list'], result[2]);
                      }
                    );
    }

    async loadAudio(filePath) {

        // Send XMLHttpRequest to server
        // ! ajax doesn't support arraybuffer.
        let url = `http://127.0.0.1:8000/${filePath}`;
        return new Promise((resolve, reject) => {
          try {
            const xhr = new XMLHttpRequest();
            xhr.open("GET", url);
            xhr.responseType = "arraybuffer";
            xhr.onerror = event => {
              reject(`Network error: ${event}`);
            };
            xhr.onload = () => {
              if (xhr.status === 200) {
                resolve(this.audioCtx.decodeAudioData(xhr.response));
              } else {
                reject(`XHR load error: ${xhr.statusText}`);
              }
            };
            xhr.send();
          } catch (err) {
            reject(err.message);
          }
        });
    }

    predict(model, dictionary, melSpectrogram) {
      if(this.modelName === "sample") {
          // sample model input require [-1, 187, 80]
          let inputTensor;
          if (melSpectrogram.length < 187) {
            let originalTensor = tf.tensor(melSpectrogram);
            let paddingTensor = tf.fill([187-melSpectrogram.length,80],-13.8);
            inputTensor = originalTensor.concat(paddingTensor);
            inputTensor = inputTensor.reshape([-1,187,80]);
          }
          else {
            // Use only first 187 frames.
            inputTensor = tf.tensor([melSpectrogram.slice(0,187)]);
          }


          let predict_tensor = model.predict(inputTensor);
          let predict_array = Array.from(predict_tensor.dataSync());

          return this.arr2str(predict_array, dictionary);
      }
      if(this.modelName === "monica") {
        let inputTensor = tf.tensor([melSpectrogram.slice(0,650)]);
        let predict_tensor = model.predict(inputTensor);
        let predict_array = Array.from(predict_tensor.dataSync());

        return this.arr2str(predict_array, dictionary);
      }
    }

    /**
     * Start recording single audio.
     * Recording automatically stop after 4sec.
     * This function will be stopped when timer is expired or stopRecord() is called.
     * @param {void} None no input parameters
     * @return {void} return nothing
     * @example
     * let recognizer = new Recognizer();
     * recognizer.selectModel("transformer");
     * recognizer.startRecord();
     *
     */
      startRecord(){
        if (this.isRecord){
          return;
        }
        if (this.isListen){
          this.stopListen();
          this.isListen = false;
        }
        this.audioCtx = new AudioContext({
          latencyHint: 'interactive',
          sampleRate: this.sampleRate,
        });
        this.audioBuffer = [];

        navigator.mediaDevices.getUserMedia({audio: true, video: false})
        .then((stream) => this.__startRecord.call(this, stream))
        .catch(this.__failRecord);
      }

      __startRecord(stream) {
        this.recordStream = stream;
        this.recordSource = this.audioCtx.createMediaStreamSource(stream);
        this.recordProcessor = this.audioCtx.createScriptProcessor(this.listenStreamSize, 1, 1); // 47872 = (fftSize/2) * modelInputLength


        this.recordSource.connect(this.recordProcessor);
        this.recordProcessor.connect(this.audioCtx.destination);

        this.recordProcessor.onaudioprocess = this.__handleAudioProcess.bind(this);

        setTimeout(this.__stopRecord.bind(this), 4000);
        this.isRecord = true;
      }

      __failRecord(e){
        console.log(`${e}`);
      }

      __handleAudioProcess(stream) {
        const streamBuffer = stream.inputBuffer.getChannelData(0);
        const nextAudioBuffer = new Float32Array(this.audioBuffer.length+streamBuffer.length);
        nextAudioBuffer.set(this.audioBuffer);
        nextAudioBuffer.set(streamBuffer, this.audioBuffer.length);
        this.audioBuffer = nextAudioBuffer;
      }

    /**
     * Stop recording single audio and start speech recognition.
     * Return value is automatically save to this.result;
     * @param {void} None no input parameters
     * @return {void} return nothing
     * @example
     * let recognizer = new Recognizer();
     * recognizer.selectModel("transformer");
     * recognizer.startRecord();
     * setTimeout(recognizer.stopRecord, 2000);
     * recognizer.result.then(console.log);
     */
    stopRecord() {
      return this.__stopRecord.call(this);
    }

    __stopRecord() {
      // TODO: do something with audiobuffer
      if (!this.isRecord) {
        return;
      }
      console.log("STOP RECORDING");
      const tracks = this.recordStream.getTracks();

      tracks.forEach(function(track) {
        track.stop();
      });

      this.recordSource.disconnect(this.recordProcessor);
      this.recordProcessor.disconnect(this.audioCtx.destination);

      this.recordStream = null;
      this.recordSource = null;
      this.recordProcessor = null;

      this.isRecord = false;
      this.result = this.predictAudioBuffer(this.audioBuffer);

      return this.result;
    }



    /**
     * Start listening from user mic.
     * Keep recognize input audio until stopListen() is called.
     * Prediction result will save to recognizer.result: Promise<string>
     *
     * @param {void} None no input parameters
     * @return {void} return nothing
     * @example
     * let recognizer = new Recognizer();
     * recognizer.selectModel("transformer");
     * recognizer.startListen();
     * recognizer.result
     *           .then(console.log)
     *
     */
    startListen() {
        // TODO : determine detailed process of listen()
        // TODO : implement Threshold
      if (this.isListen){
        return;
      }
      if (this.isRecord){
        this.stopRecord();
        this.isRecord = false;
      }
      this.listenAudioCtx = new AudioContext({
        latencyHint: 'interactive',
        sampleRate: this.listenSampleRate,
      });
      this.audioBuffer = [];

      // add EventListener for result
      document.addEventListener("onresult", this.onResult);

      navigator.mediaDevices.getUserMedia({audio: true, video: false})
      .then((stream) => this.__startListen.call(this, stream))
      .catch(this.__failListen);
    }

    __startListen(stream) {
      this.listenStream = stream;
      this.listenSource = this.listenAudioCtx.createMediaStreamSource(stream);
      this.listenProcessor = this.listenAudioCtx.createScriptProcessor(this.listenStreamSize, 1, 1); // 47872 = (fftSize/2) * modelInputLength

      this.listenSource.connect(this.listenProcessor);
      this.listenProcessor.connect(this.listenAudioCtx.destination);

      this.listenProcessor.onaudioprocess = this.__handleListenAudioProcess.bind(this);

      this.isListen = true;
    }

    __failListen(e){
      console.log(`${e}`);
    }

    __handleListenAudioProcess(stream) {
      // TODO: initializing threshold
      const streamBuffer = stream.inputBuffer.getChannelData(0);
      // playback
      this.resultArray.push(stream.inputBuffer);
      let statusHTML = document.getElementById("status");

      let soundSum = 0;
      for (let i = 0; i < streamBuffer.length; i ++) {
        soundSum+=Math.sqrt(streamBuffer[i]*streamBuffer[i]);
      }
      let soundRMS = soundSum/this.listenStreamSize;
      console.log(soundRMS);
      if(soundRMS > this.threshold){
        // FIXME: save previous 1 frame.
        // HTML Display
        statusHTML.innerHTML = "Listening...";
        const nextAudioBuffer = new Float32Array(this.audioBuffer.length+streamBuffer.length);
        nextAudioBuffer.set(this.audioBuffer);
        nextAudioBuffer.set(streamBuffer, this.audioBuffer.length);
        this.audioBuffer = nextAudioBuffer;
      }
      else if(this.audioBuffer.length > this.listenStreamSize) {
        const nextAudioBuffer = new Float32Array(this.audioBuffer.length+streamBuffer.length);
        nextAudioBuffer.set(this.audioBuffer);
        nextAudioBuffer.set(streamBuffer, this.audioBuffer.length);
        this.audioBuffer = nextAudioBuffer;

        // DownSample this.listenSampleRate to this.SampleRate
        let currAudioBuffer = this.listenAudioCtx.createBuffer(1, this.audioBuffer.length, this.listenSampleRate); // createBuffer(channels, frameCount, sampleRate);
        let nowBuffering = currAudioBuffer.getChannelData(0);
        for (let i = 0; i < this.audioBuffer.length; i++) {
          nowBuffering[i] = this.audioBuffer[i];
        }
        let tmpsource = this.listenAudioCtx.createBufferSource();
        tmpsource.buffer = currAudioBuffer;
        tmpsource.connect(this.listenAudioCtx.destination);

          // Thanks for https://stackoverflow.com/questions/27598270/resample-audio-buffer-from-44100-to-16000
          // Down
        let sourceAudioBuffer = currAudioBuffer;
        // `sourceAudioBuffer` is an AudioBuffer instance of the source audio
        // at the original sample rate.
        const DESIRED_SAMPLE_RATE = 16000;
        const offlineCtx = new OfflineAudioContext(sourceAudioBuffer.numberOfChannels, sourceAudioBuffer.duration * DESIRED_SAMPLE_RATE, DESIRED_SAMPLE_RATE);
        const cloneBuffer = offlineCtx.createBuffer(sourceAudioBuffer.numberOfChannels, sourceAudioBuffer.length, sourceAudioBuffer.sampleRate);
        // Copy the source data into the offline AudioBuffer
        for (let channel = 0; channel < sourceAudioBuffer.numberOfChannels; channel++) {
            cloneBuffer.copyToChannel(sourceAudioBuffer.getChannelData(channel), channel);
        }
        // Play it from the beginning.
        const source = offlineCtx.createBufferSource();
        source.buffer = cloneBuffer;
        source.connect(offlineCtx.destination);
        offlineCtx.oncomplete = function(e) {
          // `resampledAudioBuffer` contains an AudioBuffer resampled at 16000Hz.
          // use resampled.getChannelData(x) to get an Float32Array for channel x.

          // PlayBack
          let audioCtx = new AudioContext({
            sampleRate: 16000,
          })
          let currSource = audioCtx.createBufferSource();
          currSource.buffer = e.renderedBuffer;
          currSource.connect(audioCtx.destination);
          currSource.start();

          const resampledAudioBuffer = e.renderedBuffer;
          this.result = this.predictAudioBuffer(resampledAudioBuffer.getChannelData(0));
          this.result.then(function (resultStr) {
            // create event obj for listen
            const onResultEvent = new CustomEvent("onresult", {detail: {result: resultStr}});
            document.dispatchEvent(onResultEvent);
            console.log
          });
        }.bind(this);
        offlineCtx.startRendering();
        source.start(0);



        this.audioBuffer = [];
      }
      else {
        // hold 1 frame
        statusHTML.innerHTML = "Say Something..."
        this.audioBuffer = streamBuffer.slice();
      }
    }

    /**
     * Stop listening from user mic.
     *
     * @param {void} None no input parameters
     * @return {void} return nothing
     * @example
     * let recognizer = new Recognizer();
     * recognizer.selectModel("transformer");
     * recognizer.startListen();
     * recognizer.result
     *           .then(console.log)
     * recognizer.stopListen();
     *
     */
    stopListen() {
      return this.__stopListen.call(this);
    }

    __stopListen() {
      if (!this.isListen) {
        return;
      }
      console.log("STOP LISTENING");

      this.listenSource.disconnect(this.listenProcessor);
      this.listenProcessor.disconnect(this.listenAudioCtx.destination);

      this.listenStream = null;
      this.listenSource = null;
      this.listenProcessor = null;

      this.isListen = false;
    }





   //////////////////////////////Below codes are internal method ( private )
   // ! javascript doesn't support private method.


   /* Convert array(output tensor) to string
    *
    * input : output tensor of model
    * Output : string
    */
    arr2str(input_arr, token_list) {
        return this.groupby(input_arr).map(x => this.convert_token(x, token_list)).join("");
    }


   /* Getter same elements.
    * i.e. 'AAABBCCCAAA' --> 'ABCA'
    *
    * input : Array of any
    * Output : Array of any
    */
    groupby(input_arr) {
        if (input_arr.length === 0){
        return [];
        }
        let i = 1;
        let result_arr = [...input_arr];
        let key = result_arr[0];
        while(i < result_arr.length ) {
        while(result_arr[i] === key) {
            result_arr.splice(i-1, 1);
        }
        key = result_arr[i];
        i += 1;
        }

        return result_arr;
    }


   /* convert idx to string
    * convert <blank> to ""
    * convert <space> to " "
    * i.e. 'AAABBCCCAAA' --> 'ABCA'
    *
    * input : index, token_list
    * Output : char
    */
    convert_token(x, token_list) {
        const result = token_list[x];
        if (result === "<blank>") {
            return "";
        }
        else if (result === "<space>") {
            return " ";
        }
        return result.replace("▁", " ");
    }

    /**
     * Padding Zero
     */
    zeroPadding(buffer){
      const minBufferLength = Math.max(this.minLength*(this.fftSize/2 + 1), buffer.length+256);
      let padded_buf = new Float32Array(minBufferLength).fill(0);
      padded_buf.set(buffer, 256);
      return padded_buf;
    }
}