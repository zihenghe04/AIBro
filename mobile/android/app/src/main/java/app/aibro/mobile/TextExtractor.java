package app.aibro.mobile;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import androidx.exifinterface.media.ExifInterface;
import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader;
import com.tom_roush.pdfbox.io.MemoryUsageSetting;
import com.tom_roush.pdfbox.pdmodel.PDDocument;
import com.tom_roush.pdfbox.text.PDFTextStripper;
import com.getcapacitor.JSObject;
import java.io.ByteArrayInputStream;
import java.io.Writer;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

final class TextExtractor {
    static JSObject extract(Context context, String name, byte[] bytes) throws Exception {
        return name.toLowerCase(Locale.ROOT).endsWith(".pdf") ? pdf(context, bytes) : image(bytes);
    }
    private static JSObject pdf(Context context, byte[] bytes) throws Exception {
        PDFBoxResourceLoader.init(context);
        MemoryUsageSetting memory = MemoryUsageSetting.setupTempFileOnly(); memory.setTempDir(context.getCacheDir());
        try (PDDocument document = PDDocument.load(new ByteArrayInputStream(bytes), memory)) {
            if (!document.getCurrentAccessPermission().canExtractContent()) throw new IllegalArgumentException("PDF 不允许提取文字；原件仍可预览");
            LimitedWriter writer = new LimitedWriter();
            PDFTextStripper stripper = new PDFTextStripper(); stripper.setSortByPosition(true);
            int pages = document.getNumberOfPages();
            for (int index = 1; index <= Math.min(pages, 100) && !writer.full; index++) {
                stripper.setStartPage(index); stripper.setEndPage(index);
                LimitedWriter page = new LimitedWriter(); stripper.writeText(document, page);
                if (!page.value.toString().trim().isEmpty()) {
                    writer.append("\n\n[第 " + index + " 页]\n").append(page.value);
                    writer.full |= page.full;
                }
            }
            String warning = writer.value.length() == 0 ? "此 PDF 没有可提取文字；请使用原件预览" :
                pages > 100 || writer.full ? "提取内容已截断，请结合原件查看" : "";
            return new JSObject().put("text", writer.value.toString()).put("warning", warning);
        }
    }
    private static JSObject image(byte[] bytes) throws Exception {
        BitmapFactory.Options options = new BitmapFactory.Options(); options.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        if (options.outWidth <= 0 || options.outHeight <= 0) throw new IllegalArgumentException("图片格式不支持；原件仍可预览");
        int sample = 1;
        while (Math.max(options.outWidth / sample, options.outHeight / sample) > 4096 ||
            (long) (options.outWidth / sample) * (options.outHeight / sample) > 12000000) sample *= 2;
        options.inJustDecodeBounds = false; options.inSampleSize = sample; options.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        if (bitmap == null) throw new IllegalArgumentException("图片无法解码；原件仍可预览");
        TextRecognizer recognizer = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
        try {
            try {
                ExifInterface exif = new ExifInterface(new ByteArrayInputStream(bytes)); Matrix matrix = new Matrix();
                if (exif.isFlipped()) matrix.postScale(-1, 1);
                matrix.postRotate(exif.getRotationDegrees());
                if (!matrix.isIdentity()) {
                    Bitmap oriented = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
                    if (oriented != bitmap) { bitmap.recycle(); bitmap = oriented; }
                }
            } catch (java.io.IOException ignored) { /* Formats without EXIF use their stored orientation. */ }
            String text = Tasks.await(recognizer.process(InputImage.fromBitmap(bitmap, 0)), 120, TimeUnit.SECONDS).getText();
            boolean clipped = text.length() > NativePolicy.TEXT_LIMIT;
            return new JSObject().put("text", text.substring(0, Math.min(text.length(), NativePolicy.TEXT_LIMIT)))
                .put("warning", "图片文字由设备识别，可能有误，请对照原图" + (clipped ? "；提取内容已截断" : "") + (sample > 1 ? "；大图已缩小用于识别" : ""));
        } finally { recognizer.close(); bitmap.recycle(); }
    }
    private static final class LimitedWriter extends Writer {
        final StringBuilder value = new StringBuilder(); boolean full;
        @Override public void write(char[] chars, int offset, int length) {
            int count = Math.min(length, NativePolicy.TEXT_LIMIT - value.length());
            if (count > 0) value.append(chars, offset, count);
            if (count < length || value.length() == NativePolicy.TEXT_LIMIT) full = true;
        }
        @Override public void flush() {}
        @Override public void close() {}
    }
}
