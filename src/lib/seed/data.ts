/**
 * 内置起步大纲。
 *
 * 为什么要有：新用户第一次打开 App 是空的——没有材料就没法生成大纲，
 * 没法出题，体验是"什么都做不了"。这里内置四条学习线的知识点树，
 * 装上就能直接出题，模型调用都不需要。
 *
 * 内容定位：只放**公认的基础知识点**，不写具体标准号、不写可能过时的参数值。
 * 用户导入自己的教材/讲义后，AI 生成的个性化大纲会取代或补充这里的内容。
 */
import type { TrackId } from '../db/types';

export interface SeedNode {
  name: string;
  summary: string;
  importance: number;
  children?: SeedNode[];
}

export interface SeedOutline {
  track: TrackId;
  title: string;
  description: string;
  nodes: SeedNode[];
}

/* ============================== 电工基础 ============================== */

const FUNDAMENTAL: SeedOutline = {
  track: 'fundamental',
  title: '电工基础起步大纲',
  description: '为 PLC 打地基：电路基本概念 → 欧姆定律与基尔霍夫 → 电磁 → 交流电 → 三相 → 仪表',
  nodes: [
    {
      name: '电路的基本概念与物理量',
      summary: '搞清电流、电压、电位、电阻到底在说什么，是后面一切计算的前提',
      importance: 5,
      children: [
        { name: '电流、电压与电位', summary: '三者的定义、单位与方向约定，理解"电位是相对的"', importance: 5 },
        { name: '电阻与电阻定律', summary: '导体电阻与长度、截面积、材料的关系', importance: 4 },
        { name: '电功率与电能', summary: 'P=UI 与 W=Pt，以及千瓦时的含义', importance: 4 },
      ],
    },
    {
      name: '欧姆定律与电阻连接',
      summary: '电工计算的基本功，串并联的规律必须脱口而出',
      importance: 5,
      children: [
        { name: '欧姆定律及其应用', summary: 'I=U/R 及三个变形，会判断已知量求未知量', importance: 5 },
        { name: '串联电路的计算', summary: '电流处处相等、总电阻相加、分压关系', importance: 5 },
        { name: '并联电路的计算', summary: '电压处处相等、总电阻倒数相加、分流关系', importance: 5 },
        { name: '混联电路的化简', summary: '会识别串并联关系并把电路逐步化简', importance: 4 },
      ],
    },
    {
      name: '基尔霍夫定律与复杂电路',
      summary: '串并联公式不够用时，靠这两个定律列方程求解',
      importance: 4,
      children: [
        { name: '基尔霍夫电流定律（KCL）', summary: '节点上流入电流之和等于流出电流之和', importance: 4 },
        { name: '基尔霍夫电压定律（KVL）', summary: '任一回路内各段电压的代数和为零', importance: 4 },
        { name: '支路电流法解题', summary: '标方向、列方程、解方程的标准流程', importance: 3 },
      ],
    },
    {
      name: '电磁基础',
      summary: '电动机、变压器、接触器全都建立在这一章上',
      importance: 4,
      children: [
        { name: '磁场与磁感线', summary: '磁场的基本描述方式与右手螺旋定则', importance: 3 },
        { name: '电流的磁效应', summary: '通电导线和线圈周围会产生磁场', importance: 4 },
        { name: '电磁感应与楞次定律', summary: '变化的磁通产生感应电动势，方向总是阻碍变化', importance: 4 },
        { name: '自感与互感', summary: '线圈自身和线圈之间的电磁耦合，变压器的基础', importance: 3 },
      ],
    },
    {
      name: '单相正弦交流电',
      summary: '交流电有三要素，不能再直接套直流电路那套算法',
      importance: 5,
      children: [
        { name: '正弦交流电的三要素', summary: '最大值、角频率、初相位', importance: 4 },
        { name: '有效值与最大值的关系', summary: '有效值是最大值的 0.707 倍，为什么这样定义', importance: 4 },
        { name: '纯电阻、纯电感、纯电容电路', summary: '三种元件上电压与电流的相位关系', importance: 4 },
        { name: '阻抗与功率因数', summary: '阻抗三角形、有功功率与无功功率的区别', importance: 4 },
      ],
    },
    {
      name: '三相交流电',
      summary: '工业现场全是三相，搞错线电压和相电压是最常见的错',
      importance: 5,
      children: [
        { name: '三相电源与相序', summary: '三相对称电源的特点与相序的意义', importance: 4 },
        { name: '线电压与相电压的关系', summary: '星形接法下线电压是相电压的 √3 倍', importance: 5 },
        { name: '星形接法与三角形接法', summary: '两种接法的电压电流关系与适用场合', importance: 5 },
        { name: '三相功率的计算', summary: '有功、无功、视在功率与功率因数的关系', importance: 4 },
      ],
    },
    {
      name: '常用电工仪表与测量',
      summary: '会选表、会接线、会读数，是实操的第一道关',
      importance: 4,
      children: [
        { name: '万用表的使用与注意事项', summary: '电压/电流/电阻三档的接法与常见错误', importance: 5 },
        { name: '钳形电流表测电流', summary: '不断开线路测电流，只能卡单根导线', importance: 3 },
        { name: '兆欧表测量绝缘电阻', summary: '停电、放电、摇测的标准步骤', importance: 4 },
      ],
    },
  ],
};

/* ============================== PLC ============================== */

const PLC: SeedOutline = {
  track: 'plc',
  title: 'PLC 起步大纲',
  description: '硬件结构 → IO 接线 → 梯形图指令 → 定时器计数器 → 顺序控制 → 典型电路 → 调试',
  nodes: [
    {
      name: 'PLC 基础与硬件结构',
      summary: '先弄清 PLC 到底怎么"跑程序"，后面写程序才不会凭感觉',
      importance: 5,
      children: [
        { name: 'PLC 的组成与工作原理', summary: 'CPU、电源、输入输出模块各自干什么', importance: 5 },
        { name: '扫描周期与输入输出刷新', summary: '为什么程序里的输入状态整周期不变，这决定了很多写法', importance: 5 },
        { name: '常见品牌与选型思路', summary: '西门子、三菱等主流品牌的系列差异与选型考虑', importance: 3 },
      ],
    },
    {
      name: '输入输出与接线',
      summary: '现场问题一大半出在接线上，而不是程序上',
      importance: 5,
      children: [
        { name: '数字量输入接线（源型与漏型）', summary: '两种接法区别，以及和传感器类型的配合', importance: 5 },
        { name: '数字量输出类型', summary: '继电器输出、晶体管输出、晶闸管输出的负载能力与适用场合', importance: 4 },
        { name: '模拟量输入输出', summary: '量程换算的思路，以及屏蔽与接地要求', importance: 3 },
      ],
    },
    {
      name: '梯形图与基本指令',
      summary: '把继电器控制思路翻译成程序的第一套工具',
      importance: 5,
      children: [
        { name: '梯形图的基本规则与能流概念', summary: '从左到右、从上到下，能流不能倒流', importance: 5 },
        { name: '常开常闭触点与输出线圈', summary: '触点的通断条件与线圈的驱动', importance: 5 },
        { name: '置位与复位指令', summary: '与自锁回路的对应关系，什么时候比自锁更合适', importance: 4 },
        { name: '上升沿与下降沿', summary: '只在一个扫描周期内有效的信号，按钮计数必须用', importance: 4 },
      ],
    },
    {
      name: '定时器与计数器',
      summary: '所有"延时""计数""循环"都靠这两个',
      importance: 5,
      children: [
        { name: '通电延时定时器', summary: '满足条件后延时动作，最常用的一种', importance: 5 },
        { name: '断电延时定时器', summary: '条件消失后继续维持一段时间', importance: 4 },
        { name: '计数器指令', summary: '加计数、减计数与复位，用于产量统计和循环控制', importance: 4 },
      ],
    },
    {
      name: '顺序控制与程序结构',
      summary: '把复杂动作拆成一步步，是写出可维护程序的关键',
      importance: 4,
      children: [
        { name: '顺序功能图（SFC）的思路', summary: '用步和转换条件描述工艺流程', importance: 4 },
        { name: '步进控制程序的写法', summary: '按步置位复位，避免大量自锁互相缠绕', importance: 4 },
        { name: '子程序与中断', summary: '程序分层，以及中断的适用场景', importance: 3 },
      ],
    },
    {
      name: 'PLC 典型控制电路编程',
      summary: '这几类电路是面试和现场最常考的，必须能默写',
      importance: 5,
      children: [
        { name: '电机启停控制', summary: '点动与长动的区别，自锁怎么用程序实现', importance: 5 },
        { name: '电机正反转与互锁', summary: '双重互锁的必要性：电气互锁加程序互锁', importance: 5 },
        { name: '星三角降压启动', summary: '启动与运行的切换时序和切换间隔', importance: 5 },
        { name: '多台电机的顺序启停', summary: '按顺序启动、按逆序停止的编程思路', importance: 4 },
      ],
    },
    {
      name: '调试与故障排查',
      summary: '会写程序只是一半，会找问题才算会用',
      importance: 4,
      children: [
        { name: '程序监控与强制操作', summary: '在线监控、强制输出与使用风险', importance: 4 },
        { name: '常见输入输出故障判断', summary: '先分清是外围线路问题还是程序问题', importance: 4 },
      ],
    },
  ],
};

/* ============================== 低压电工证 ============================== */

const LOWVOLTAGE_CERT: SeedOutline = {
  track: 'lowvoltage-cert',
  title: '低压电工证理论大纲',
  description: '覆盖特种作业操作证（低压电工）理论考试的主要范围：安全法规、安全用电、触电急救、电工基础、仪表工具、材料与导线、低压电器与电机、控制线路、照明配电、接地防雷',
  nodes: [
    {
      name: '安全生产法律法规',
      summary: '送分题集中区，但要记牢责任划分',
      importance: 5,
      children: [
        { name: '安全生产法的基本要求', summary: '从业人员的权利与义务、生产经营单位的责任', importance: 4 },
        { name: '特种作业人员管理规定', summary: '持证上岗、复审周期、违章作业的后果', importance: 5 },
        { name: '电工的职业安全职责', summary: '作业前中后的安全责任边界', importance: 4 },
      ],
    },
    {
      name: '安全用电与触电防护',
      summary: '这一章直接关系到人身安全，必考且不能错',
      importance: 5,
      children: [
        { name: '电流对人体的伤害', summary: '不同电流大小和通过路径对人体的影响', importance: 5 },
        { name: '常见的触电方式', summary: '单相触电、两相触电、跨步电压触电的区别', importance: 5 },
        { name: '安全电压与安全距离', summary: '不同环境下的安全电压等级与最小安全距离概念', importance: 5 },
      ],
    },
    {
      name: '触电急救',
      summary: '实操考核重点，步骤错一步就不及格',
      importance: 5,
      children: [
        { name: '脱离电源的正确方法', summary: '先断电再施救，以及不能直接拉拽的原因', importance: 5 },
        { name: '心肺复苏的操作要点', summary: '按压位置、深度、频率与人工呼吸的配合', importance: 5 },
        { name: '现场急救的禁忌', summary: '哪些做法会加重伤害，例如随意搬动伤者', importance: 4 },
      ],
    },
    {
      name: '电气防火与防爆',
      summary: '事故案例题的主要来源',
      importance: 4,
      children: [
        { name: '电气火灾的常见原因', summary: '短路、过载、接触不良、散热不良', importance: 5 },
        { name: '灭火器的选择与使用', summary: '带电灭火只能用干粉或二氧化碳，不能用水', importance: 5 },
        { name: '爆炸危险场所的基本要求', summary: '防爆电器的选型思路与作业禁忌', importance: 3 },
      ],
    },
    {
      name: '电工基础知识',
      summary: '理论卷的计算题主要出自这里',
      importance: 5,
      children: [
        { name: '直流电路的基本定律', summary: '欧姆定律、串并联规律、功率计算', importance: 5 },
        { name: '单相与三相交流电', summary: '有效值、线电压与相电压、星三角接法', importance: 5 },
        { name: '电磁基本知识', summary: '电流的磁效应与电磁感应现象', importance: 3 },
      ],
    },
    {
      name: '常用电工仪表与工具',
      summary: '考"怎么用"和"什么情况下不能用"',
      importance: 4,
      children: [
        { name: '万用表、钳形表、兆欧表', summary: '各自的用途与接线要求', importance: 5 },
        { name: '验电器的正确使用', summary: '验电前后都要确认验电器本身完好', importance: 5 },
        { name: '绝缘工具的检查与使用', summary: '外观检查、定期试验与使用禁忌', importance: 4 },
      ],
    },
    {
      name: '电工材料与导线连接',
      summary: '实操题常考，规范细节多',
      importance: 4,
      children: [
        { name: '常用导电材料与绝缘材料', summary: '铜铝的性能差异与适用场合', importance: 3 },
        { name: '导线连接的基本要求', summary: '接触电阻要小、机械强度要够、绝缘要恢复', importance: 5 },
        { name: '导线绝缘的恢复', summary: '绝缘胶带的缠绕方法与层数要求', importance: 4 },
      ],
    },
    {
      name: '低压电器与电动机',
      summary: '认元件、会选型、懂保护',
      importance: 5,
      children: [
        { name: '断路器与漏电保护器', summary: '过载短路保护与漏电保护的区别，漏电保护器不能替代接地', importance: 5 },
        { name: '熔断器与热继电器', summary: '各自的保护对象与整定原则', importance: 4 },
        { name: '三相异步电动机的结构与铭牌', summary: '铭牌参数含义与接法选择', importance: 5 },
      ],
    },
    {
      name: '电气控制线路',
      summary: '和 PLC 那条线重叠，学一次两处都用得上',
      importance: 5,
      children: [
        { name: '点动与自锁控制', summary: '自锁触点的作用与回路走向', importance: 5 },
        { name: '正反转与互锁', summary: '为什么必须互锁，不互锁会怎样', importance: 5 },
        { name: '星三角降压启动', summary: '启动电流的降低原理与切换时序', importance: 4 },
        { name: '行程开关与限位控制', summary: '位置检测与自动往返的实现', importance: 3 },
      ],
    },
    {
      name: '照明与配电线路',
      summary: '实操接线题的高频考点',
      importance: 4,
      children: [
        { name: '照明灯具与开关的接线', summary: '开关必须控制火线，这是安全底线', importance: 5 },
        { name: '插座的接线规则', summary: '左零右火上接地的由来与验证方法', importance: 5 },
        { name: '配电箱的安装要求', summary: '回路划分、导线截面与标识要求', importance: 3 },
      ],
    },
    {
      name: '接地与防雷',
      summary: '概念容易混，考试爱挖坑',
      importance: 5,
      children: [
        { name: '保护接地与保护接零', summary: '两种保护方式的原理、适用系统与区别', importance: 5 },
        { name: '重复接地的作用', summary: '为什么要重复接地，不重复接地有什么风险', importance: 4 },
        { name: '防雷装置的基本组成', summary: '接闪器、引下线、接地装置的作用', importance: 3 },
      ],
    },
    {
      name: '安全技术措施与作业规范',
      summary: '实操和理论都考，属于"流程分"',
      importance: 5,
      children: [
        { name: '停电、验电、装设接地线', summary: '顺序不能颠倒，每一步的原因', importance: 5 },
        { name: '悬挂标示牌与装设遮栏', summary: '不同标示牌的含义与悬挂位置', importance: 4 },
        { name: '工作票与操作票的基本概念', summary: '两票三制的作用与执行要点', importance: 3 },
      ],
    },
  ],
};

/* ============================== 电工中级等级证 ============================== */

const MIDLEVEL_CERT: SeedOutline = {
  track: 'midlevel-cert',
  title: '电工中级等级证理论大纲',
  description: '比初级更深一层：电路分析定理 → 交流电路分析 → 模电数电 → 电机拖动 → 电气控制与 PLC → 测量 → 工艺规范',
  nodes: [
    {
      name: '电路分析基础',
      summary: '从"会算"进阶到"会简化电路"',
      importance: 4,
      children: [
        { name: '叠加定理', summary: '多个电源分别作用再叠加，注意适用范围', importance: 4 },
        { name: '戴维南定理与诺顿定理', summary: '把复杂网络等效成电压源或电流源', importance: 4 },
        { name: 'RC 与 RL 过渡过程', summary: '时间常数的含义与暂态过程的特点', importance: 3 },
      ],
    },
    {
      name: '正弦交流电路分析',
      summary: '相量法是后面所有交流计算的语言',
      importance: 4,
      children: [
        { name: '相量法', summary: '把正弦量变成相量来做加减乘除', importance: 4 },
        { name: '谐振电路', summary: '串联谐振与并联谐振的条件与特点', importance: 3 },
        { name: '功率因数的提高', summary: '为什么要补偿、怎么补偿、补偿容量的思路', importance: 4 },
      ],
    },
    {
      name: '模拟电子技术基础',
      summary: '理解整流、放大、运放这三块就够应付考试',
      importance: 4,
      children: [
        { name: '二极管与整流电路', summary: '单向导电性与半波、桥式整流的区别', importance: 4 },
        { name: '三极管与基本放大电路', summary: '放大条件与三种组态的特点', importance: 3 },
        { name: '集成运算放大器的基本应用', summary: '比例、加法、比较等典型电路', importance: 3 },
      ],
    },
    {
      name: '数字电子技术基础',
      summary: 'PLC 程序的底层逻辑就是这些',
      importance: 4,
      children: [
        { name: '逻辑门与逻辑代数', summary: '与或非门、真值表与化简', importance: 4 },
        { name: '组合逻辑电路', summary: '编码器、译码器等典型电路的思路', importance: 3 },
        { name: '触发器与时序逻辑', summary: 'RS、D、JK 触发器的功能与区别', importance: 3 },
      ],
    },
    {
      name: '电机与拖动',
      summary: '中级证的重量级章节',
      importance: 5,
      children: [
        { name: '三相异步电动机的工作原理', summary: '旋转磁场的产生与转差率的意义', importance: 5 },
        { name: '机械特性与启动制动', summary: '转矩-转速曲线以及常用启动制动方式', importance: 4 },
        { name: '电动机的调速方式', summary: '变极、变频、改变转差率等思路的对比', importance: 4 },
      ],
    },
    {
      name: '电气控制与 PLC',
      summary: '把继电器控制和 PLC 打通，是中级工的核心能力',
      importance: 5,
      children: [
        { name: '常用控制线路的分析方法', summary: '读图顺序与回路划分的技巧', importance: 4 },
        { name: 'PLC 基本指令与应用', summary: '把继电器电路翻译成梯形图', importance: 5 },
        { name: '变频器的基本使用', summary: '接线端子、参数设置与常见故障', importance: 4 },
      ],
    },
    {
      name: '电气测量与仪表',
      summary: '考"测什么、用什么、怎么读"',
      importance: 3,
      children: [
        { name: '电桥与补偿法测量', summary: '精确测量电阻与电动势的思路', importance: 2 },
        { name: '示波器的使用', summary: '波形观察、周期与幅值的读取', importance: 3 },
        { name: '误差分析与数据处理', summary: '系统误差与偶然误差的区分与处理', importance: 3 },
      ],
    },
    {
      name: '安全文明生产与工艺',
      summary: '实操评分里占比很高',
      importance: 4,
      children: [
        { name: '电气识图与绘图规范', summary: '图形符号、文字符号与图纸的读法', importance: 4 },
        { name: '装配与配线工艺', summary: '走线、压接、标识的规范要求', importance: 4 },
        { name: '检修流程与记录', summary: '故障排查的规范流程与记录要求', importance: 3 },
      ],
    },
  ],
};

/* ============================== 导出 ============================== */

export const SEED_OUTLINES: SeedOutline[] = [FUNDAMENTAL, PLC, LOWVOLTAGE_CERT, MIDLEVEL_CERT];

export function getSeedOutline(track: TrackId): SeedOutline | undefined {
  return SEED_OUTLINES.find((s) => s.track === track);
}

/** 统计一棵种子树里一共有多少个知识点（含子节点） */
export function countSeedNodes(nodes: SeedNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + (n.children ? countSeedNodes(n.children) : 0), 0);
}
