"""Feature Engineering — Technical Indicators + Market Structure + Cross-Asset"""
import logging
import pandas as pd
import numpy as np

logger = logging.getLogger(__name__)

class FeatureEngineering:
    def __init__(self, config):
        self.config = config
        self.ind = config["indicators"]

    def compute_all(self, df, warmup=True):
        """Compute full feature set for a single ticker/timeframe"""
        if df is None or len(df) < 50:
            return pd.DataFrame()
        df = df.copy()
        df = self._technical(df)
        df = self._volume(df)
        df = self._market_structure(df)
        df = self._stationarity(df)
        df = self._regime_features(df)
        if warmup:
            warmup_n = self.config["data"]["warmup_candles"]
            df = df.iloc[warmup_n:].copy()
        df.replace([np.inf, -np.inf], np.nan, inplace=True)
        df.ffill(inplace=True)
        df.dropna(inplace=True)
        return df

    def _technical(self, df):
        close = df['Close']
        high = df['High']
        low = df['Low']

        # EMAs
        for p in self.ind["ema_periods"]:
            df[f'ema_{p}'] = close.ewm(span=p, adjust=False).mean()

        # EMA relationships
        df['ema_9_20_cross'] = df['ema_9'] - df['ema_20']
        df['ema_20_50_cross'] = df['ema_20'] - df['ema_50']
        df['price_ema20_pct'] = (close - df['ema_20']) / df['ema_20']

        # RSI
        df['rsi'] = self._rsi(close, self.ind["rsi_period"])
        df['rsi_overbought'] = (df['rsi'] > 70).astype(int)
        df['rsi_oversold'] = (df['rsi'] < 30).astype(int)

        # MACD
        ema_fast = close.ewm(span=self.ind["macd_fast"], adjust=False).mean()
        ema_slow = close.ewm(span=self.ind["macd_slow"], adjust=False).mean()
        df['macd'] = ema_fast - ema_slow
        df['macd_signal'] = df['macd'].ewm(span=self.ind["macd_signal"], adjust=False).mean()
        df['macd_hist'] = df['macd'] - df['macd_signal']
        df['macd_cross'] = np.sign(df['macd_hist'])

        # ATR
        df['atr'] = self._atr(high, low, close, self.ind["atr_period"])
        df['atr_pct'] = df['atr'] / close

        # Bollinger Bands
        sma = close.rolling(self.ind["bb_period"]).mean()
        std = close.rolling(self.ind["bb_period"]).std()
        df['bb_upper'] = sma + std * self.ind["bb_std"]
        df['bb_lower'] = sma - std * self.ind["bb_std"]
        df['bb_width'] = (df['bb_upper'] - df['bb_lower']) / sma
        df['bb_pct'] = (close - df['bb_lower']) / (df['bb_upper'] - df['bb_lower'] + 1e-8)
        df['bb_squeeze'] = (df['bb_width'] < df['bb_width'].rolling(20).mean() * 0.8).astype(int)

        # Stochastic RSI
        rsi = df['rsi']
        rsi_min = rsi.rolling(14).min()
        rsi_max = rsi.rolling(14).max()
        df['stoch_rsi'] = (rsi - rsi_min) / (rsi_max - rsi_min + 1e-8)

        # ADX
        df['adx'] = self._adx(high, low, close, self.ind["adx_period"])
        df['trending'] = (df['adx'] > self.ind["adx_trending_threshold"]).astype(int)
        df['ranging'] = (df['adx'] < self.ind["adx_ranging_threshold"]).astype(int)

        # VWAP (session-based approximation)
        if 'Volume' in df.columns:
            typical = (high + low + close) / 3
            df['vwap'] = (typical * df['Volume']).cumsum() / (df['Volume'].cumsum() + 1e-8)
            df['price_vwap_pct'] = (close - df['vwap']) / (df['vwap'] + 1e-8)

        return df

    def _volume(self, df):
        vol = df['Volume']
        avg = vol.rolling(self.ind["volume_avg_period"]).mean()
        df['volume_ratio'] = vol / (avg + 1e-8)
        df['volume_spike'] = (df['volume_ratio'] > 2).astype(int)
        df['volume_trend'] = vol.rolling(5).mean() / (vol.rolling(20).mean() + 1e-8)
        df['obv'] = (np.sign(df['Close'].diff()) * vol).cumsum()
        df['obv_ma'] = df['obv'].rolling(20).mean()
        return df

    def _market_structure(self, df):
        close = df['Close']
        high = df['High']
        low = df['Low']

        # Higher highs / lower lows
        df['hh'] = (high > high.shift(1)).astype(int)
        df['ll'] = (low < low.shift(1)).astype(int)
        df['hl'] = (low > low.shift(1)).astype(int)
        df['lh'] = (high < high.shift(1)).astype(int)

        # Pivot points (simplified)
        df['pivot'] = (high.shift(1) + low.shift(1) + close.shift(1)) / 3
        df['resistance'] = 2 * df['pivot'] - low.shift(1)
        df['support'] = 2 * df['pivot'] - high.shift(1)
        df['price_above_pivot'] = (close > df['pivot']).astype(int)

        # Breakout detection
        rolling_high = high.rolling(20).max()
        rolling_low = low.rolling(20).min()
        df['breakout_up'] = (close > rolling_high.shift(1)).astype(int)
        df['breakout_down'] = (close < rolling_low.shift(1)).astype(int)

        # Price momentum
        for p in [1, 3, 5, 10]:
            df[f'return_{p}'] = close.pct_change(p)

        return df

    def _stationarity(self, df):
        """Convert to stationary features"""
        close = df['Close']
        df['log_return'] = np.log(close / close.shift(1))
        df['z_return'] = (df['log_return'] - df['log_return'].rolling(20).mean()) / (df['log_return'].rolling(20).std() + 1e-8)
        return df

    def _regime_features(self, df):
        """Regime indicators"""
        df['volatility_regime'] = df['atr_pct'].rolling(20).mean()
        df['trend_strength'] = df['adx'] / 50.0  # normalize
        return df

    def create_labels(self, df, tp_mult=2.0, sl_mult=1.0, horizon=12):
        """Create binary labels: 1 if TP hit before SL within horizon candles"""
        labels = []
        close = df['Close'].values
        atr = df['atr'].values if 'atr' in df.columns else np.ones(len(df)) * df['Close'].std() * 0.01

        for i in range(len(df) - horizon):
            entry = close[i]
            tp = entry + atr[i] * tp_mult
            sl = entry - atr[i] * sl_mult
            label = 0
            for j in range(1, horizon + 1):
                if i + j >= len(close): break
                p = close[i + j]
                if p >= tp: label = 1; break
                if p <= sl: label = 0; break
            labels.append(label)

        labels.extend([np.nan] * horizon)
        df = df.copy()
        df['label'] = labels
        return df.dropna(subset=['label'])

    def get_feature_cols(self, df):
        exclude = ['Open','High','Low','Close','Volume','label','vwap','pivot','support','resistance']
        return [c for c in df.columns if c not in exclude and not c.startswith('Unnamed')]

    # ─── Indicator implementations ────────────────────────────────────────────
    @staticmethod
    def _rsi(series, period):
        delta = series.diff()
        gain = delta.clip(lower=0).rolling(period).mean()
        loss = (-delta.clip(upper=0)).rolling(period).mean()
        rs = gain / (loss + 1e-8)
        return 100 - (100 / (1 + rs))

    @staticmethod
    def _atr(high, low, close, period):
        tr = pd.concat([high - low, (high - close.shift()).abs(), (low - close.shift()).abs()], axis=1).max(axis=1)
        return tr.rolling(period).mean()

    @staticmethod
    def _adx(high, low, close, period):
        up = high.diff()
        down = -low.diff()
        plus_dm = up.where((up > down) & (up > 0), 0)
        minus_dm = down.where((down > up) & (down > 0), 0)
        tr = pd.concat([high - low, (high - close.shift()).abs(), (low - close.shift()).abs()], axis=1).max(axis=1)
        atr = tr.rolling(period).mean()
        plus_di = 100 * (plus_dm.rolling(period).mean() / (atr + 1e-8))
        minus_di = 100 * (minus_dm.rolling(period).mean() / (atr + 1e-8))
        dx = 100 * ((plus_di - minus_di).abs() / (plus_di + minus_di + 1e-8))
        return dx.rolling(period).mean()
