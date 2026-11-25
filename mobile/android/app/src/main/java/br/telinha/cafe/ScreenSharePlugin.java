package br.telinha.cafe;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

@CapacitorPlugin(name = "ScreenShare")
public class ScreenSharePlugin extends Plugin {
    private MediaProjection mediaProjection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private DisplayManager displayManager;
    private DisplayManager.DisplayListener displayListener;
    private HandlerThread captureThread;
    private Handler captureHandler;
    private long lastFrameMs = 0;
    private int maxSidePx = 720;
    private int targetWidth = 720;
    private int targetHeight = 1280;
    private int targetFps = 18;
    private int jpegQuality = 72;
    private boolean running = false;

    private int[] computeTargetSize() {
        DisplayMetrics dm = new DisplayMetrics();
        WindowManager wm = (WindowManager) getContext().getSystemService(Context.WINDOW_SERVICE);
        if (wm != null && wm.getDefaultDisplay() != null) {
            wm.getDefaultDisplay().getRealMetrics(dm);
        } else {
            dm = getContext().getResources().getDisplayMetrics();
        }
        int sw = Math.max(1, dm.widthPixels);
        int sh = Math.max(1, dm.heightPixels);
        float scale = Math.min(1f, (float) maxSidePx / Math.max(sw, sh));
        int w = Math.max(2, (Math.round(sw * scale) / 2) * 2);
        int h = Math.max(2, (Math.round(sh * scale) / 2) * 2);
        return new int[]{ w, h, dm.densityDpi };
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (running) {
            JSObject ret = new JSObject();
            ret.put("width", targetWidth);
            ret.put("height", targetHeight);
            call.resolve(ret);
            return;
        }
        maxSidePx = Math.max(360, Math.min(1280, call.getInt("maxSide", 720)));
        targetFps = Math.max(8, Math.min(30, call.getInt("fps", 18)));
        jpegQuality = Math.max(40, Math.min(90, call.getInt("quality", 72)));

        int[] sz = computeTargetSize();
        targetWidth = sz[0];
        targetHeight = sz[1];

        MediaProjectionManager mpm = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mpm == null) {
            call.reject("MediaProjection indisponível neste aparelho.");
            return;
        }
        Intent intent = mpm.createScreenCaptureIntent();
        startActivityForResult(call, intent, "onScreenCapturePermission");
    }

    @ActivityCallback
    private void onScreenCapturePermission(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("Permissão de captura de tela cancelada.");
            return;
        }
        try {
            final int resultCode = result.getResultCode();
            final Intent resultData = result.getData();
            ScreenShareService.setOnReady(() -> startProjectionAfterService(call, resultCode, resultData));
            Intent svc = new Intent(getContext(), ScreenShareService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(svc);
            } else {
                getContext().startService(svc);
            }
        } catch (Exception e) {
            ScreenShareService.setOnReady(null);
            stopInternal(false);
            call.reject("Erro ao iniciar serviço de captura: " + e.getMessage());
        }
    }

    private void startProjectionAfterService(PluginCall call, int resultCode, Intent resultData) {
        try {
            MediaProjectionManager mpm = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            mediaProjection = mpm.getMediaProjection(resultCode, resultData);
            if (mediaProjection == null) {
                stopInternal(false);
                call.reject("Não foi possível iniciar a captura de tela.");
                return;
            }

            captureThread = new HandlerThread("TelinhaScreenCap");
            captureThread.start();
            captureHandler = new Handler(captureThread.getLooper());

            mediaProjection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    stopInternal(true);
                }
            }, captureHandler);

            DisplayMetrics dm = getContext().getResources().getDisplayMetrics();
            imageReader = ImageReader.newInstance(targetWidth, targetHeight, PixelFormat.RGBA_8888, 2);
            imageReader.setOnImageAvailableListener(this::onFrameAvailable, captureHandler);

            virtualDisplay = mediaProjection.createVirtualDisplay(
                "TelinhaCafeScreen",
                targetWidth,
                targetHeight,
                dm.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                imageReader.getSurface(),
                null,
                captureHandler
            );

            ScreenShareService.setOnStopRequested(() -> stopInternal(true));
            displayManager = (DisplayManager) getContext().getSystemService(Context.DISPLAY_SERVICE);
            if (displayManager != null) {
                displayListener = new DisplayManager.DisplayListener() {
                    @Override public void onDisplayAdded(int displayId) {}
                    @Override public void onDisplayRemoved(int displayId) {}
                    @Override
                    public void onDisplayChanged(int displayId) {
                        if (!running || virtualDisplay == null) return;
                        int[] sz = computeTargetSize();
                        if (sz[0] == targetWidth && sz[1] == targetHeight) return;
                        targetWidth = sz[0];
                        targetHeight = sz[1];
                        ImageReader oldReader = imageReader;
                        ImageReader nextReader = ImageReader.newInstance(targetWidth, targetHeight, PixelFormat.RGBA_8888, 2);
                        nextReader.setOnImageAvailableListener(ScreenSharePlugin.this::onFrameAvailable, captureHandler);
                        imageReader = nextReader;
                        virtualDisplay.resize(targetWidth, targetHeight, sz[2]);
                        virtualDisplay.setSurface(nextReader.getSurface());
                        if (oldReader != null) { try { oldReader.close(); } catch (Throwable ignored) {} }
                    }
                };
                displayManager.registerDisplayListener(displayListener, captureHandler);
            }

            running = true;
            JSObject ret = new JSObject();
            ret.put("width", targetWidth);
            ret.put("height", targetHeight);
            call.resolve(ret);
        } catch (Exception e) {
            stopInternal(false);
            call.reject("Erro ao iniciar captura: " + e.getMessage());
        }
    }

    private void onFrameAvailable(ImageReader reader) {
        Image image = null;
        try {
            image = reader.acquireLatestImage();
            if (image == null || !running) return;
            long now = System.currentTimeMillis();
            long minInterval = 1000L / targetFps;
            if (now - lastFrameMs < minInterval) return;
            lastFrameMs = now;

            Image.Plane[] planes = image.getPlanes();
            if (planes.length == 0) return;
            ByteBuffer buffer = planes[0].getBuffer();
            int pixelStride = planes[0].getPixelStride();
            int rowStride = planes[0].getRowStride();
            int rowPadding = rowStride - pixelStride * targetWidth;

            Bitmap raw = Bitmap.createBitmap(
                targetWidth + rowPadding / pixelStride,
                targetHeight,
                Bitmap.Config.ARGB_8888
            );
            raw.copyPixelsFromBuffer(buffer);
            Bitmap cropped = rowPadding > 0
                ? Bitmap.createBitmap(raw, 0, 0, targetWidth, targetHeight)
                : raw;
            if (cropped != raw) raw.recycle();

            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            cropped.compress(Bitmap.CompressFormat.JPEG, jpegQuality, baos);
            cropped.recycle();

            String b64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);
            JSObject ev = new JSObject();
            ev.put("data", "data:image/jpeg;base64," + b64);
            ev.put("width", targetWidth);
            ev.put("height", targetHeight);
            notifyListeners("frame", ev);
        } catch (Throwable ignored) {
        } finally {
            if (image != null) {
                try { image.close(); } catch (Throwable ignored) {}
            }
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopInternal(false);
        call.resolve();
    }

    private synchronized void stopInternal(boolean notify) {
        running = false;
        ScreenShareService.setOnReady(null);
        ScreenShareService.setOnStopRequested(null);
        if (displayManager != null && displayListener != null) {
            try { displayManager.unregisterDisplayListener(displayListener); } catch (Throwable ignored) {}
            displayListener = null;
        }
        if (virtualDisplay != null) {
            try { virtualDisplay.release(); } catch (Throwable ignored) {}
            virtualDisplay = null;
        }
        if (imageReader != null) {
            try { imageReader.close(); } catch (Throwable ignored) {}
            imageReader = null;
        }
        if (mediaProjection != null) {
            try { mediaProjection.stop(); } catch (Throwable ignored) {}
            mediaProjection = null;
        }
        if (captureThread != null) {
            try { captureThread.quitSafely(); } catch (Throwable ignored) {}
            captureThread = null;
            captureHandler = null;
        }
        try {
            getContext().stopService(new Intent(getContext(), ScreenShareService.class));
        } catch (Throwable ignored) {}
        if (notify) notifyListeners("stopped", new JSObject());
    }

    @Override
    protected void handleOnDestroy() {
        stopInternal(false);
        super.handleOnDestroy();
    }
}
