const dbConnection = require("../config/dbConnection");
const logger = require('../util/logger');
const express = require('express');
const router = express.Router();
const commonResponse = require('../commonResponse/commonResponse');
const {response, request} = require("express");
const {error, rejections} = require("winston");
const orderStatus = {
    PLACED: 1,
    PROGRESS: 2,
    SERVED:3,
    CANCELED:0,
}

const getItemPriceQuery="SELECT SELLING_PRICE FROM core_inv_item WHERE Id_Item=?";
const placeOrderQuery="INSERT INTO core_mobile_reservation_order (`RESERVATION_ID`, `USER_ID`, `ITEM_ID`, `ORDER_STATUS`,`QUANTITY`) VALUES (?,?,?,?,?)";
let checkOrderStatusQuery="SELECT * FROM core_mobile_reservation_order WHERE RESERVATION_ORDER_ID=?";


/**
* @swagger
* /order/calculate-current-bill:
*   get:
*     summary: Calculate current bill for a reservation
*     description: Calculates the current bill for a given reservation based on the items ordered.
*     requestBody:
*       required: true
*       content:
*         application/json:
*           schema:
    *             type: object
*             properties:
*               reservationId:
    *                 type: string
*                 description: The ID of the reservation for which bill needs to be calculated.
*     responses:
*       200:
*         description: Successful response. Returns the calculated bill value.
*         content:
*           application/json:
*             schema:
    *               type: object
*               properties:
*                 billValue:
    *                   type: number
*                   description: The calculated bill value.
*       400:
*         description: Bad request. Invalid input data.
*       500:
*         description: Internal server error. Unable to calculate bill.
*/
router.get('/calculate-current-bill', (req, res) => {
    let reservationId=req.body.reservationId;
    let itemList=[];



    dbConnection.getConnectionFromPool((err, connection) => {
        if (err) {
            logger.error("Unable to connect to database");
            commonResponse.sendErrorResponse(res, "Unable to connect to database", req.requestId, 500);
            return;
        }else{
            getItemList(reservationId).then(results=>{
                itemList=results;
                console.log(itemList);
                calculateBill().then(bill=>{
                    commonResponse.sendSuccessResponse(res,{"TotalBill":bill },req.requestId)
                }).catch(error=>{
                    logger.error(error);
                    commonResponse.sendErrorResponse(res,"Unable to process bill",req.requestId,500);
                })
            }).catch(error=>{
                console.log(error);
                commonResponse.sendErrorResponse(res,"Unable to process bill",req.requestId,500);
            }).finally(()=>{
                connection.release();
            })

        }

        function getItemList(reservationId){
            return new Promise((resolve, reject)=>{
                let getItemListQuery='SELECT core_mobile_reservation_order.ITEM_ID,core_mobile_reservation_order.QUANTITY FROM core_mobile_reservation JOIN core_mobile_reservation_order ON core_mobile_reservation.RESERVATION_ID=core_mobile_reservation_order.RESERVATION_ID WHERE core_mobile_reservation.RESERVATION_ID=? AND core_mobile_reservation_order.ORDER_STATUS=3;';
                connection.query(getItemListQuery,[reservationId],(error, results,fields)=>{
                   if(error){
                       reject(error);
                   }else{
                       resolve(results);
                   }
                });
            });

        }
        function calculateBill(){
            let bill=0;
            return new Promise((resolve,reject)=>{
                for (let i = 0; i < itemList.length; i++) {
                    getItemPrice(itemList[i].ITEM_ID).then((price)=>{
                       bill=bill+(price*itemList[i].QUANTITY);
                       if(i==itemList.length-1){
                          resolve(bill);
                       }
                    }).catch((error)=>{
                        reject(error);
                    })
                }
            })

        }

        function getItemPrice(id){
            return new Promise((resolve, reject)=>{
                connection.query(getItemPriceQuery,[id],(error,results,fields)=>{
                    if(error){
                        reject(error)
                    }else{
                        resolve(results[0].SELLING_PRICE)
                    }
                })
            })
        }

    }, req.requestId);
});

/**
 * @swagger
 * /order/place-order:
 *   post:
 *     summary: Place an order
 *     description: Endpoint to place an order for a single item.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reservationId:
 *                 type: string
 *                 description: The ID of the reservation.
 *               userId:
 *                 type: string
 *                 description: The ID of the user placing the order.
 *               itemId:
 *                 type: string
 *                 description: The ID of the item being ordered.
 *               quantity:
 *                 type: integer
 *                 description: The quantity of the item being ordered.
 *     responses:
 *       200:
 *         description: Successfully placed the order
 *       500:
 *         description: Unable to place the order
 */
router.post('/place-order',(req,res)=>{
    let reservationId=req.body.reservationId;
    let userId=req.body.userId;
    let itemId=req.body.itemId;
    let quantity=req.body.quantity;


    dbConnection.getConnectionFromPool((error,connection)=>{
        if(error){
            logger.error("Unable to connect to database");
            commonResponse.sendErrorResponse(res,"Unable to connect database",req.requestId,500)
        }else{
            placeSingleOrder(connection,reservationId,userId,itemId,quantity).then(results=>{
                commonResponse.sendSuccessResponse(res,{"orderId":results.insertId,
                                                            "orderStatus":orderStatus.PLACED,
                                                            },req.requestId);
            }).catch(error=>{
                commonResponse.sendErrorResponse(res,"Unable ti place order",req.requestId,500)
            })

        }
    },req.requestId)

})

/**
 * @swagger
 * /order/edit-order:
 *   post:
 *     summary: Edit an existing order
 *     description: Edit the status or quantity of an existing order. At least one of orderStatus or quantity should be provided.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               orderId:
 *                 type: string
 *                 description: The ID of the order to edit.
 *               orderStatus:
 *                 type: string
 *                 description: The new status of the order.
 *               quantity:
 *                 type: integer
 *                 description: The new quantity of the order.
 *     responses:
 *       200:
 *         description: Success message indicating the order was successfully edited.
 *       400:
 *         description: Bad request if both orderStatus and quantity are missing in the request.
 */
router.post('/edit-order',(req,res)=>{
    let orderId=req.body.orderId;
    let orderStatus=req.body.orderStatus;
    let quantity=req.body.quantity;

    let updateOrderQuery="UPDATE core_mobile_reservation_order SET  ";

    if(orderStatus!=""){
        let updateStatus=" ORDER_STATUS="+orderStatus
        updateOrderQuery=updateOrderQuery+updateStatus;
    }
    if(quantity!=""){
        let updateQuantity=" QUANTITY="+quantity
        updateOrderQuery=updateOrderQuery+updateQuantity
    }


    dbConnection.getConnectionFromPool((err,connection)=>{
        if(err){
            logger.error("Unable to connect to database");
            commonResponse.sendErrorResponse(res,"Unable to connect database",req.requestId,500);
        }else{
            connection.query(checkOrderStatusQuery,[orderId],(error,results,fields)=>{
                if(error){
                    logger.error("Unable to retrieve data from database",error);
                    commonResponse.sendErrorResponse(res,"Unable to retrieve data from database",req.requestId,500);
                }else{
                    if(results[0].ORDER_STATUS===1){
                        connection.query(updateOrderQuery+" WHERE RESERVATION_ORDER_ID=?",[orderId],(error,results,fields)=>{
                            if(error){
                                logger.error("Unable to edit order status");
                                commonResponse.sendErrorResponse(res,"Unable to edit table status",req.requestId,500)
                            }else{
                                commonResponse.sendSuccessResponse(res,{
                                    "orderId":orderId,
                                    "OrderStatus":orderStatus,
                                    "quantity":quantity
                                },req.requestId);
                            }

                        })
                    }else{
                        logger.error("Unable to change order in current status");
                        commonResponse.sendErrorResponse(res,"Unable to change order in current status",req.requestId,400)
                    }
                }
            })
        }
    },req.requestId)


})

/**
 * @swagger
 * /order/get-order-detail/{orderId}:
 *   post:
 *     summary: Get details of a specific order.
 *     description: Retrieve details of the order specified by its ID.
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the order to retrieve details for.
 *     responses:
 *       200:
 *         description: Details of the specified order.
 *       400:
 *         description: Bad request if the order ID is missing or invalid.
 *       500:
 *         description: Internal server error if unable to retrieve order details.
 */
router.get('/get-order-detail/:orderId',(req,res)=>{
    const orderId = req.params.orderId;
    dbConnection.getConnectionFromPool((err,connection)=>{
        if(err){
            logger.error("Unable to connect database");
            commonResponse.sendErrorResponse(res,"unable to connect database",req.requestId,500)
        }else{
            connection.query(checkOrderStatusQuery,[orderId],(error,results,fields)=>{
                if(error){
                    logger.error("Unable to retrieve order data")
                    commonResponse.sendErrorResponse(res,"unable to retrieve data",req.requestId,500)
                }else{
                    commonResponse.sendSuccessResponse(res,results,req.requestId)
                }
            })
        }
    },req.requestId)
})


function placeSingleOrder(connection,reservationId,userId,itemId,quantity){
    return new Promise((resolve,reject)=>{
            connection.query(placeOrderQuery,[reservationId,userId,itemId,orderStatus.PLACED,quantity],(error,results,fields)=>{
                if(error){
                   logger.error("Unable to insert order",error)
                    reject(error);
                }else{
                   resolve(results);
                }
            });

    });
}
function calculateBill(itemPrice,quantity){
    return itemPrice*quantity;
}

module.exports = router;