// 模拟 v2rayNG 的解析方式（java.net.URI + 同样的非法字符修正），检查分享链接能被正确解析
import java.net.URI;
public class UriCheck { public static void main(String[] a) throws Exception {
  java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(System.in));
  String s; while ((s = r.readLine()) != null) { if (s.isEmpty()) continue;
    try { URI u = new URI(s.replace(" ", "%20").replace("|", "%7C"));
      System.out.println("OK host=" + u.getHost() + " port=" + u.getPort() + " user=" + u.getUserInfo() + " q=" + u.getRawQuery());
    } catch (Exception e) { System.out.println("FAIL " + e.getMessage()); } } } }
