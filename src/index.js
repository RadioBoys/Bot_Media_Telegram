import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const execPromise = util.promisify(exec);

// THAY TOKEN BOT CỦA ÔNG VÀO ĐÂY
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const RAPID_API_KEY = process.env.RAPID_API_KEY;


const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Đường dẫn trỏ tới file cookie trong thư mục dự án
const cookiePath = path.resolve('facebook_cookies.txt');

// Regex cho X (Twitter) và Lệnh tải thủ công /d
const twitterRegex = /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[a-zA-Z0-9_]+\/status\/([0-9]+)/;
const commandRegex = /^\/(d|download)\s+(https?:\/\/\S+)/i;

/**
 * Hàm gửi tin nhắn tự động xóa sau X mili-giây (mặc định 5000ms = 5s)
 */
async function sendTemporaryMessage(chatId, text, replyToMessageId = null, delay = 5000) {
    try {
        const options = replyToMessageId ? { reply_to_message_id: replyToMessageId, parse_mode: 'Markdown' } : { parse_mode: 'Markdown' };
        const sentMsg = await bot.sendMessage(chatId, text, options);

        setTimeout(async () => {
            try {
                await bot.deleteMessage(chatId, sentMsg.message_id);
            } catch (err) {
                console.error('[❌ Xóa tin nhắn lỗi]:', err.message);
            }
        }, delay);
    } catch (error) {
        console.error('[❌ Gửi tin nhắn tạm thời lỗi]:', error.message);
    }
}

async function executeWithRetry(command, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const { stdout } = await execPromise(command);
            return stdout;
        } catch (error) {
            console.log(`[🔄 Lần thử ${i + 1}/${retries}] Lỗi: ${error.message}`);
            if (i === retries - 1) throw error; // Nếu hết số lần thử thì mới báo lỗi
            await new Promise(resolve => setTimeout(resolve, 2000)); // Nghỉ 2s trước khi thử lại
        }
    }
}

async function processDownload(chatId, text, messageId) {
    const isTwitter = twitterRegex.test(text);
    const isTikTok = text.includes('tiktok.com') || text.includes('douyin.com');
    const isFacebook = text.includes('facebook.com') || text.includes('fb.watch') || text.includes('fb.gg');

    if (isTwitter || isTikTok || isFacebook) {
        let url = "";

        if (isTwitter) {
            url = text.match(twitterRegex)[0];
        } else {
            url = text.trim();
        }

        // Thông báo nhận diện link
        await sendTemporaryMessage(chatId, `🔍 *Nhận diện:* Đang xử lý link gửi đi...`, messageId);

        // Bật trạng thái hiển thị "Bot đang gửi video..." trên Telegram
        await bot.sendChatAction(chatId, 'upload_video');

        // 1. XỬ LÝ LINK FACEBOOK (SỬ DỤNG YT-DLP + COOKIES BYPASS)
        if (isFacebook) {
            try {
                await sendTemporaryMessage(chatId, `🚀 *API:* Đang trích xuất video Facebook...`, messageId);

                // Gọi API thay cho yt-dlp
                const response = await axios.post('https://gendownload.com/api/extract',
                    { url: url },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                            'Referer': 'https://gendownload.com/'
                        }
                    }
                );

                const data = response.data;
                console.log(`[DEBUG] Dữ liệu trả về từ API:`, data);

                if (data && data.formats) {
                    // Logic ưu tiên: HD, nếu không có thì lấy SD
                    const videoData = data.formats.find(item => item.label === 'HD') ||
                        data.formats.find(item => item.label === 'SD');

                    if (videoData && videoData.url) {
                        await sendTemporaryMessage(chatId, `📥 *Get Link:* Thành công! Chất lượng: ${videoData.label}. Đang tải về...`, messageId);

                        // Stream dữ liệu trực tiếp từ link của API
                        const fileStream = await axios({
                            method: 'get',
                            url: videoData.url,
                            responseType: 'stream'
                        });

                        await sendTemporaryMessage(chatId, `📤 *Telegram:* Đang đẩy video lên nhóm...`, messageId);

                        const videoTitle = data.title || 'Facebook Video';
                        await bot.sendVideo(chatId, fileStream.data, {
                            reply_to_message_id: messageId,
                            caption: `🎬 **${videoTitle}**\n🔗 [Xem link gốc](${url})`,
                            parse_mode: 'Markdown'
                        }, {
                            filename: `facebook_video_${videoData.label}.mp4`,
                            contentType: 'video/mp4'
                        });
                    } else {
                        await sendTemporaryMessage(chatId, `❌ *Thất Bại:* Không tìm thấy link video (HD/SD).`, messageId);
                    }
                } else {
                    await sendTemporaryMessage(chatId, `❌ *Thất Bại:* Dữ liệu phản hồi từ API không hợp lệ.`, messageId);
                }
            } catch (error) {
                console.error('[❌ Lỗi API Facebook]:', error.message);
                await sendTemporaryMessage(chatId, `💥 *Lỗi API Facebook:* \`${error.message}\``, messageId);
            }
        }

        // 2. XỬ LÝ LINK TIKTOK (GIỮ NGUYÊN RAPIDAPI)
        if (isTikTok) {
            try {
                await sendTemporaryMessage(chatId, `🚀 *RapidAPI:* Đang kết nối máy chủ tải video TikTok...`, messageId);

                const options = {
                    method: 'POST',
                    url: 'https://auto-download-all-in-one.p.rapidapi.com/v1/social/autolink',
                    headers: {
                        'x-rapidapi-key': RAPID_API_KEY,
                        'x-rapidapi-host': 'auto-download-all-in-one.p.rapidapi.com',
                        'Content-Type': 'application/json'
                    },
                    data: { url: url }
                };

                const response = await axios.request(options);
                const resData = response.data;

                if (resData && resData.medias && resData.medias.length > 0) {
                    const videoMedia = resData.medias.find(m => m.type === 'video');

                    if (videoMedia && videoMedia.url) {
                        await sendTemporaryMessage(chatId, `📥 *Get Link:* Đã lấy được link stream TikTok. Đang tải...`, messageId);
                        const fileStream = await axios({ method: 'get', url: videoMedia.url, responseType: 'stream' });

                        await sendTemporaryMessage(chatId, `📤 *Telegram:* Đang đẩy dữ liệu video lên nhóm...`, messageId);

                        await bot.sendVideo(chatId, fileStream.data, {
                            reply_to_message_id: messageId,
                            caption: `🎬 **Video TikTok của ông đây!**\n🔗 [Xem link gốc trên TikTok](${url})`,
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        { text: `🔹 Original TikTok Link`, url: url }
                                    ]
                                ]
                            }
                        }, { filename: `tiktok_video.mp4`, contentType: 'video/mp4' });

                    } else {
                        await sendTemporaryMessage(chatId, `❌ *Thất Bại:* Không tìm thấy file video hợp lệ trong dữ liệu TikTok trả về.`, messageId);
                    }
                } else {
                    await sendTemporaryMessage(chatId, `❌ *Thất Bại:* Video TikTok có thể ở chế độ riêng tư hoặc lỗi cấu trúc JSON.`, messageId);
                }
            } catch (error) {
                await sendTemporaryMessage(chatId, `💥 *Lỗi Hệ Thống TikTok:* \`${error.message}\``, messageId);
            }
        }

        // 3. XỬ LÝ LINK X (TWITTER)
        if (isTwitter) {
            try {
                const apiUrl = url.replace(/twitter\.com|x\.com/, 'api.vxtwitter.com');
                const response = await axios.get(apiUrl);
                const data = response.data;

                if (data && data.media_extended && data.media_extended.length > 0) {
                    for (const media of data.media_extended) {
                        await sendTemporaryMessage(chatId, `📥 *Get Link:* Đang kéo stream video X (Twitter)...`, messageId);
                        const fileStream = await axios({ method: 'get', url: media.url, responseType: 'stream' });

                        await sendTemporaryMessage(chatId, `📤 *Telegram:* Đang chuẩn bị gửi video X...`, messageId);
                        await bot.sendVideo(chatId, fileStream.data, {
                            reply_to_message_id: messageId,
                            caption: `🐦 **Video X (Twitter) của ông đây!**\n🔗 [Xem link gốc trên X](${url})`,
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        { text: '🐤 Original Link', url: url }
                                    ]
                                ]
                            }
                        }, { filename: 'x_video.mp4', contentType: 'video/mp4' });
                    }
                } else {
                    await sendTemporaryMessage(chatId, `❌ *Thất Bại:* Không tìm thấy video trên bài đăng X này.`, messageId);
                }
            } catch (error) {
                await sendTemporaryMessage(chatId, `💥 *Lỗi Hệ Thống X:* \`${error.message}\``, messageId);
            }
        }
    }
}

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const messageId = msg.message_id;

    if (!text) return;

    const commandMatch = text.match(commandRegex);
    if (commandMatch) {
        const extractedUrl = commandMatch[2];
        await processDownload(chatId, extractedUrl, messageId);
        return;
    }

    await processDownload(chatId, text, messageId);
});

console.log('Bot tối thượng phiên bản tích hợp yt-dlp Cookies đang chạy...');