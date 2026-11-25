package br.telinha.cafe;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ScreenSharePlugin.class);
        super.onCreate(savedInstanceState);
        // Tela não apaga enquanto o app está aberto (assistindo uma transmissão).
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        // Os vídeos das salas tocam com som sem precisar tocar antes, como no PC.
        getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        dispatchDeepLink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        dispatchDeepLink(intent);
    }

    private void dispatchDeepLink(Intent intent) {
        if (intent == null) return;
        Uri data = intent.getData();
        if (data == null || !"telinha".equalsIgnoreCase(data.getScheme())) return;
        String host = data.getHost();
        if (host == null || !host.matches("(?i)[A-Z0-9]{6}")) return;
        final String code = host.toUpperCase();
        getBridge().getWebView().postDelayed(() ->
            getBridge().getWebView().evaluateJavascript(
                "window.__telinhaDeepLink && window.__telinhaDeepLink('" + code + "');", null
            ), 600);
    }
}
